#!/usr/bin/env node
import { routeProviderFetch } from "./fixtures/provider-fetch.mjs";
import { strict as assert } from "node:assert";
import { closeSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createHandworkAgent,
  createHandworkTerminal,
  handworkSdkApiVersion,
  libhandworkApiVersion,
  listModels,
} from "../node.js";
import * as browser from "../browser.js";

assert.equal(libhandworkApiVersion, 2);
assert.equal(handworkSdkApiVersion, 2);
assert.equal(browser.libhandworkApiVersion, 2);
assert.equal(typeof browser.createHandworkAgent, "function");
assert.equal(typeof browser.createHandworkTerminal, "function");
assert.equal(typeof browser.listModels, "function");
assert.equal(typeof listModels, "function");

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const realNativeAddon = resolve(scriptDir, "../../zig-out/lib/libhandwork.node");
const dir = await mkdtemp(resolve(tmpdir(), "libhandwork-loader-"));
const nativePath = resolve(dir, "native.mjs");
await writeFile(nativePath, `
  export const libhandworkApiVersion = 2;
  export async function createHandworkTerminal(options) { return { backend: "native-terminal", options }; }
`);
const nativeUrl = pathToFileURL(nativePath);

const highLevelAgentPath = resolve(dir, "high-level-agent.mjs");
await writeFile(highLevelAgentPath, `
  export const libhandworkApiVersion = 2;
  export function createHandworkAgent() { throw new Error("high-level createHandworkAgent invoked"); }
`);

// Complete the fixture directory before a runtime caches its module-resolution entries.
const coreOnlyPath = resolve(dir, "core-only.mjs");
await writeFile(coreOnlyPath, `
  export const libhandworkApiVersion = 3;
  export function createCore() { throw new Error("unused createCore"); }
`);
const incompatiblePath = resolve(dir, "incompatible.mjs");
await writeFile(incompatiblePath, `
  export const libhandworkApiVersion = 4;
  export async function createHandworkAgent() {}
`);
const versionFixtures = [
  ["missing-version", `
    export function createCore() { throw new Error("missing-version createCore invoked"); }
  `],
  ["unequal-version", `
    export const libhandworkApiVersion = 4;
    export function createCore() { throw new Error("unequal-version createCore invoked"); }
  `],
];
for (const [name, source] of versionFixtures) await writeFile(resolve(dir, `${name}.mjs`), source);
const matchingVersionPath = resolve(dir, "matching-version.mjs");
await writeFile(matchingVersionPath, `
  export const libhandworkApiVersion = 3;
  export function createCore() {
    const error = new Error("matching-version createCore invoked");
    error.code = "MATCHING_VERSION_INVOKED";
    throw error;
  }
`);
await assert.rejects(
  createHandworkAgent({
    backend: "native",
    nativeAddon: pathToFileURL(highLevelAgentPath),
    
  }),
  (error) => error?.code === "LIBHANDWORK_NATIVE_UNAVAILABLE" &&
    error.message.includes("createCore") &&
    !String(error.cause).includes("high-level createHandworkAgent invoked"),
);


await assert.rejects(
  createHandworkAgent({
    nativeAddon: nativeUrl,
    
    env: { HANDWORK_MODEL: "legacy/model" },
  }),
  (error) => error instanceof TypeError && error.message.includes("host fetch adapter"),
);
await assert.rejects(
  browser.createHandworkAgent({  env: { HANDWORK_MODEL: "legacy/model" } }),
  (error) => error instanceof TypeError && error.message.includes("host fetch adapter"),
);
await assert.rejects(
  createHandworkAgent({ nativeAddon: nativeUrl,  env: undefined }),
  (error) => error instanceof TypeError && error.message.includes("host fetch adapter"),
);

for (const [options, errorType, message] of [
  [{  model: "" }, TypeError, "model"],
  [{  model: 1 }, TypeError, "model"],
  [{  model: "x".repeat(1_025) }, RangeError, "1024"],
]) {
  await assert.rejects(
    createHandworkAgent({ backend: "native", nativeAddon: realNativeAddon, ...options }),
    (error) => error instanceof errorType && error.message.includes(message),
  );
}

const terminal = await createHandworkTerminal({ nativeAddon: nativeUrl, env: { HANDWORK_THEME: "dark" }, marker: 2 });
assert.equal(terminal.backend, "native-terminal");
assert.equal(terminal.options.marker, 2);
assert.deepEqual(terminal.options.env, { HANDWORK_THEME: "dark" });

const savedSuspending = WebAssembly.Suspending;
const savedPromising = WebAssembly.promising;
try {
  Object.defineProperty(WebAssembly, "Suspending", { configurable: true, value: undefined });
  Object.defineProperty(WebAssembly, "promising", { configurable: true, value: undefined });
  await assert.rejects(
    createHandworkAgent({ nativeAddon: nativeUrl, backend: "wasm",  }),
    (error) => error?.code === "LIBHANDWORK_JSPI_REQUIRED" &&
      error.message.includes("--experimental-wasm-jspi"),
  );
  await assert.rejects(
    createHandworkAgent({ nativeAddon: realNativeAddon,  instructions: "x".repeat(65_537) }),
    (error) => error instanceof RangeError && error.message.includes("65536"),
  );
  await assert.rejects(
    createHandworkAgent({
      nativeAddon: realNativeAddon,
      checkpoint: new Uint8Array([1, 2, 3]),
      
    }),
    (error) => error.message.includes("Invalid or non-fresh libhandwork checkpoint"),
  );
} finally {
  Object.defineProperty(WebAssembly, "Suspending", { configurable: true, value: savedSuspending });
  Object.defineProperty(WebAssembly, "promising", { configurable: true, value: savedPromising });
}

await assert.rejects(
  createHandworkTerminal({ nativeAddon: pathToFileURL(coreOnlyPath), backend: "native" }),
  (error) => error?.code === "LIBHANDWORK_NATIVE_UNAVAILABLE" &&
    error.message.includes("createHandworkTerminal"),
);

await assert.rejects(
  createHandworkAgent({ nativeAddon: pathToFileURL(incompatiblePath), backend: "native",  }),
  (error) => error?.code === "LIBHANDWORK_NATIVE_UNAVAILABLE" &&
    error.message.includes("incompatible"),
);

for (const [name] of versionFixtures) {
  const modulePath = resolve(dir, `${name}.mjs`);
  await assert.rejects(
    createHandworkAgent({ nativeAddon: pathToFileURL(modulePath), backend: "native",  }),
    (error) => error?.code === "LIBHANDWORK_NATIVE_UNAVAILABLE" &&
      error.message.includes("incompatible") &&
      !String(error.cause).includes("createCore invoked"),
    `${name} low-level addon must fail before createCore invocation`,
  );
}

await assert.rejects(
  createHandworkAgent({ nativeAddon: pathToFileURL(matchingVersionPath), backend: "native",  }),
  (error) => error?.code === "MATCHING_VERSION_INVOKED",
  "matching v3 low-level addon must reach createCore",
);

const addon = createRequire(import.meta.url)(realNativeAddon);
let failedCore;
let failedCoreDestroyed = false;
const brokenReaderAddon = {
  ...addon,
  createCore(options) { return failedCore = addon.createCore(options); },
  takeCoreReadyFd(core) {
    const fd = addon.takeCoreReadyFd(core);
    closeSync(fd);
    return fd;
  },
  destroyCore(core) {
    failedCoreDestroyed = true;
    return addon.destroyCore(core);
  },
};
try {
  await assert.rejects(createHandworkAgent({ backend: "native", nativeAddon: brokenReaderAddon,  }));
  assert.ok(failedCoreDestroyed, "failed readiness adoption must still destroy the native runtime");
} finally {
  if (failedCore) addon.destroyCore(failedCore);
}

console.log("libhandwork loader passed: browser exports, native preference, fallback diagnostics, semantic errors, strict low-level API validation, and failed-start cleanup");
