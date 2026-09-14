#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandworkAgent } from "../node.js";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const addon = resolve(process.argv[2] || resolve(scriptDir, "../../zig-out/lib/libhandwork.node"));
let timeoutId;
let fetchCalls = 0;
let catalogCalls = 0;
const agent = await createHandworkAgent({
  nativeAddon: addon,
  backend: "native",
  fetch(_url, init) {
    if (init.method === "GET") {
      catalogCalls += 1;
      return Response.json({ models: [{ id: "native/test-model", type: "language" }].filter(model => model.type === "language").map(model => ({ slug: model.id, visibility: "list", supported_in_api: true, context_window: 272000, supported_reasoning_levels: [], input_modalities: ["text"] })) });
    }
    assert.equal(init.method, "POST");
    fetchCalls += 1;
    const error = new Error("host timeout");
    error.name = "AbortError";
    throw error;
  },
  
  model: "native/test-model",
});

let closed = false;
try {
  const turn = agent.prompt("fail host fetch");
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("native host-fetch failure hung")), 5000);
  });
  await assert.rejects(
    Promise.race([turn.result, timeout]),
    (error) => error.message !== "native host-fetch failure hung",
  );
  assert.equal(fetchCalls, 2, "an exhausted host transport must stop after one retry");
  assert.equal(catalogCalls, 1);
  assert.equal(await agent.close(), undefined);
  closed = true;
  console.log("native host-fetch failure passed: independent AbortError fails without hanging");
} finally {
  clearTimeout(timeoutId);
  if (!closed) await agent.close().catch(() => {});
}
