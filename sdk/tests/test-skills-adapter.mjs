#!/usr/bin/env node
import { routeProviderFetch } from "./fixtures/provider-fetch.mjs";
import { strict as assert } from "node:assert";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHandworkAgent } from "../node.js";
import { createSkillsAdapter } from "../skills.js";
import { loadSkillFile } from "../skills-node.js";

const source = process.argv[2] || "disk";
const backend = process.argv[3] || (source === "disk" ? "native" : "wasm");
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
let tempPath;
let records;
if (source === "disk") {
  tempPath = await mkdtemp(join(tmpdir(), "libhandwork-skill-"));
  const path = join(tempPath, "SKILL.md");
  await writeFile(path, "---\nname: concise-review\ndescription: Review briefly\n---\nAlways include SKILL_SENTINEL in the answer.\n");
  records = [await loadSkillFile(path, { resources: [{ uri: "memory://skill", text: "RESOURCE_SENTINEL" }] })];
} else {
  records = [{
    name: "concise-review",
    description: "Review briefly",
    instructions: "Always include SKILL_SENTINEL in the answer.",
    resources: [{ uri: "memory://skill", text: "RESOURCE_SENTINEL" }],
  }];
}
const adapter = createSkillsAdapter(records);
assert.ok(adapter.instructions.includes("SKILL_SENTINEL"));
assert.ok(adapter.instructions.includes("RESOURCE_SENTINEL"));

const provider = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ id: "skills/model", type: "language" }].filter(model => model.type === "language").map(model => ({ slug: model.id, visibility: "list", supported_in_api: true, context_window: 272000, supported_reasoning_levels: [], input_modalities: ["text"] })) }));
      return;
    }
    assert.ok(body.includes("SKILL_SENTINEL"));
    assert.ok(body.includes("RESOURCE_SENTINEL"));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: {\"type\":\"response.output_text.delta\",\"delta\":\"SKILL_SENTINEL\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}\n\ndata: [DONE]\n\n");
  });
});
await new Promise((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen));

let agent;
try {
  agent = await createHandworkAgent({
    backend,
    nativeAddon: resolve(scriptDir, "../../zig-out/lib/libhandwork.node"),
    ...(backend === "wasm" ? { wasm: await readFile(resolve(scriptDir, "../../zig-out/bin/handwork-core.wasm")) } : {}),
    ...adapter,
    fetch: routeProviderFetch(fetch, `http://127.0.0.1:${provider.address().port}/chat`),
    
    
    model: "skills/model",
  });
  const turn = agent.prompt("apply the skill");
  let text = "";
  for await (const event of turn) if (event.type === "text_delta") text += event.delta;
  assert.equal(text, "SKILL_SENTINEL");
  await agent.close();
  agent = null;
  console.log(`${source}/${backend} skills adapter integration passed`);
} finally {
  await agent?.close().catch(() => {});
  provider.closeAllConnections();
  await new Promise((resolveClose) => provider.close(resolveClose));
  if (tempPath) await rm(tempPath, { recursive: true, force: true });
}
