#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "libhandwork-node-package-"));
const packageDir = join(temp, "package");
const consumerDir = join(temp, "consumer");
const installedPackage = join(consumerDir, "node_modules", "libhandwork");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

try {
  run(process.execPath, [resolve(repoRoot, "sdk/scripts/package-libhandwork.mjs"), packageDir]);

  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  assert.deepEqual(manifest.exports["."], {
    node: { import: "./node.js", require: "./node.cjs" },
    browser: "./browser.js",
    default: "./browser.js",
  });
  assert.deepEqual(manifest.exports["./node"], { import: "./node.js", require: "./node.cjs" });
  assert.equal(manifest.exports["./browser"], "./browser.js");
  assert.equal(manifest.exports["./wasm"], "./handwork-sdk.js");
  assert.equal(manifest.exports["./mcp"], "./mcp.js");
  assert.equal(manifest.exports["./skills"], "./skills.js");
  assert.equal(manifest.exports["./skills/node"], "./skills-node.js");

  const cjs = await readFile(join(packageDir, "node.cjs"), "utf8");
  assert.doesNotMatch(cjs, new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
    assert.match(cjs, new RegExp(`libhandwork\\.${platform}\\.node`));
  }

  const source = await readFile(resolve(repoRoot, "sdk/node.js"), "utf8");
  assert.doesNotMatch(source, /["']\.\/libhandwork\.node["']/);
  for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
    assert.match(source, new RegExp(`["']\\.\\/libhandwork\\.${platform}\\.node["']`));
  }

  await cp(packageDir, installedPackage, { recursive: true });
  await writeFile(join(consumerDir, "package.json"), '{"type":"module"}\n');
  await writeFile(join(consumerDir, "esm.mjs"), `
    import * as libhandwork from "libhandwork";
    import * as nodeEntry from "libhandwork/node";
    const { createHandworkAgent, createHandworkTerminal, getBackendInfo } = libhandwork;
    if (JSON.stringify(Object.keys(libhandwork).sort()) !== JSON.stringify(Object.keys(nodeEntry).sort())) {
      throw new Error("root and Node subpath ESM exports differ");
    }
    const info = await getBackendInfo({ backend: "native" });
    if (typeof createHandworkAgent !== "function" || typeof createHandworkTerminal !== "function" || info.backend !== "native") {
      throw new Error(JSON.stringify(info));
    }
    const agent = await createHandworkAgent({ backend: "native" });
    const checkpoint = await agent.checkpoint();
    await agent.close();
    if (!(checkpoint instanceof Uint8Array) || checkpoint.length === 0) throw new Error("empty checkpoint");
    console.log(JSON.stringify(Object.keys(libhandwork).sort()));
  `);
  await writeFile(join(consumerDir, "cjs.cjs"), `
    const libhandwork = require("libhandwork");
    const nodeEntry = require("libhandwork/node");
    const { createHandworkAgent, createHandworkTerminal, getBackendInfo } = libhandwork;
    (async () => {
      if (JSON.stringify(Object.keys(libhandwork).sort()) !== JSON.stringify(Object.keys(nodeEntry).sort())) {
        throw new Error("root and Node subpath CommonJS exports differ");
      }
      const info = await getBackendInfo({ backend: "native" });
      if (typeof createHandworkAgent !== "function" || typeof createHandworkTerminal !== "function" || info.backend !== "native") {
        throw new Error(JSON.stringify(info));
      }
      const agent = await createHandworkAgent({ backend: "native" });
      const checkpoint = await agent.checkpoint();
      await agent.close();
      if (!(checkpoint instanceof Uint8Array) || checkpoint.length === 0) throw new Error("empty checkpoint");
      console.log(JSON.stringify(Object.keys(libhandwork).sort()));
    })();
  `);

  const esm = run(process.execPath, ["esm.mjs"], { cwd: consumerDir });
  const cjsResult = run(process.execPath, ["--no-experimental-require-module", "cjs.cjs"], { cwd: consumerDir });
  assert.deepEqual(JSON.parse(cjsResult.stdout), JSON.parse(esm.stdout));
  console.log("Node package passed: conditional exports, relocated CJS, literal native assets, and bare imports");
} finally {
  await rm(temp, { recursive: true, force: true });
}
