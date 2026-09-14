#!/usr/bin/env node
import { routeProviderFetch } from "./fixtures/provider-fetch.mjs";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandworkAgent } from "../node.js";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
let requestedAuthorization;
let requestedModel;
const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ id: "minimal/model", type: "language" }].filter(model => model.type === "language").map(model => ({ slug: model.id, visibility: "list", supported_in_api: true, context_window: 272000, supported_reasoning_levels: [], input_modalities: ["text"] })) }));
      return;
    }
    requestedAuthorization = request.headers.authorization;
    requestedModel = request.headers["ai-language-model-id"];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"think\"}",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}",
      "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}",
      "data: [DONE]",
      "",
    ].join("\n\n"));
  });
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const { port } = server.address();

let agent;
try {
  agent = await createHandworkAgent({
    backend: "native",
    nativeAddon: resolve(scriptDir, "../../zig-out/lib/libhandwork.node"),
    fetch: routeProviderFetch(fetch, `http://127.0.0.1:${port}/chat`),
    
    
    model: "minimal/model",
  });
  assert.deepEqual(Object.keys(agent).sort(), ["checkpoint", "close", "prompt"]);
  const turn = agent.prompt("hello");
  let text = "";
  let reasoning = "";
  for await (const event of turn) {
    if (event.type === "text_delta") text += event.delta;
    if (event.type === "reasoning_delta") reasoning += event.delta;
  }
  assert.equal(text, "hello");
  assert.equal(reasoning, "think");
  assert.deepEqual(await turn.result, {
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  assert.equal(requestedAuthorization, "Bearer minimal-key");
  assert.equal(requestedModel, "minimal/model");
  const checkpoint = await agent.checkpoint();
  assert.ok(checkpoint instanceof Uint8Array);
  assert.equal(await agent.close(), undefined);
  assert.equal(await agent.close(), undefined);
  console.log("minimal libhandwork API passed");
} finally {
  await agent?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}
