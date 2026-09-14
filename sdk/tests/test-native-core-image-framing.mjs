#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandworkAgent } from "../node.js";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const addon = resolve(process.argv[2] || resolve(scriptDir, "../../zig-out/lib/libhandwork.node"));
const home = await mkdtemp(join(tmpdir(), "handwork-native-image-framing-"));
const signature = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP0cAAAAASUVORK5CYII=", "base64");
const image = Buffer.alloc(3.5 * 1024 * 1024 * 3 / 4);
signature.copy(image);
const data = image.toString("base64");
const images = [1, 2].map(() => ({ type: "image", mimeType: "image/png", data }));
const result = { type: "libhandwork.tool-result", text: "two screenshots", images };
assert.equal(Buffer.byteLength(JSON.stringify({ text: result.text, images })), 7_340_169);
let requests = 0;
let toolCalls = 0;
let agent;
const timer = setTimeout(() => assert.fail("native image framing timed out"), 10_000);
const sse = (...events) => new Response(
  [...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join(""),
  { headers: { "content-type": "text/event-stream" } },
);

try {
  agent = await createHandworkAgent({
    backend: "native",
    nativeAddon: addon,
    home,
    workspaceRoot: home,
    
    model: "native/image-model",
    tools: [{
      name: "screenshots",
      description: "Take two screenshots",
      inputSchema: { type: "object", properties: {} },
      execute() {
        toolCalls += 1;
        return result;
      },
    }],
    fetch(_url, init) {
      if (init.method === "GET") {
        return Response.json({ models: [{ id: "native/image-model", type: "language", tags: ["tool-use", "vision", "file-input"] }].filter(model => model.type === "language").map(model => ({ slug: model.id, visibility: "list", supported_in_api: true, context_window: 272000, supported_reasoning_levels: [], input_modalities: ["text"] })) });
      }
      requests += 1;
      if (requests === 1) return sse(
        { type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "images1", call_id: "images1", name: "screenshots", arguments: JSON.stringify({}) } },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: ({}).inputTokens?.total ?? 0, output_tokens: ({}).outputTokens?.total ?? 0 } } },
      );
      assert.equal(requests, 2);
      assert.ok(init.body.length < 8 * 1024 * 1024);
      assert.ok(Buffer.from(init.body).toString("base64").length > 8 * 1024 * 1024);
      const payload = JSON.parse(Buffer.from(init.body).toString("utf8"));
      const received = payload.prompt.flatMap((message) => message.content ?? [])
        .filter((part) => part.type === "tool-result")
        .flatMap((part) => part.output.value ?? [])
        .filter((part) => part.type === "image-data");
      assert.deepEqual(received, images.map(() => ({ type: "image-data", data, mediaType: "image/png" })));
      return sse(
        { type: "response.output_text.delta", delta: "received images" },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: ({}).inputTokens?.total ?? 0, output_tokens: ({}).outputTokens?.total ?? 0 } } },
      );
    },
  });
  const turn = agent.prompt("take screenshots");
  assert.equal((await turn.result).stopReason, "end_turn");
  assert.equal(toolCalls, 1);
  assert.equal(requests, 2);

  // The retained images plus this prompt exceed the unchanged raw request budget.
  await assert.rejects(agent.prompt("x".repeat(2 * 1024 * 1024)).result, /HostStreamBackpressure/);
  assert.equal(requests, 2, "an oversized raw request must not reach host fetch");
  console.log("native image framing passed: accepted images survive base64 framing; oversized raw requests stay bounded");
} finally {
  clearTimeout(timer);
  await agent?.close();
  await rm(home, { recursive: true, force: true });
}
