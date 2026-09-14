#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { listModels as listBrowserModels } from "../browser.js";
import { listModels as listNodeModels } from "../node.js";

for (const [surface, listModels] of [["node", listNodeModels], ["browser", listBrowserModels]]) {
  let calls = 0;
  const models = await listModels({
    
    
    async fetch(url, init) {
      calls += 1;
      assert.equal(String(url), "https://chatgpt.com/backend-api/codex/models");
      assert.equal(init.method, "GET");
      assert.equal(new Headers(init.headers).get("authorization"), null);
      return Response.json({ models: [
          { id: "z/model", type: "language" },
          { id: "image/model", type: "image" },
          { id: "a/model", type: "language" },
          { id: "z/model", type: "language" },
          { id: "", type: "language" },
          { nope: true },
        ].filter(model => model.type === "language").map(model => ({ slug: model.id, visibility: "list", supported_in_api: true, context_window: 272000, supported_reasoning_levels: [], input_modalities: ["text"] })) });
    },
  });
  assert.deepEqual(models, ["a/model", "z/model"]);
  assert.equal(calls, 1, `${surface} listModels must perform one explicit request`);

  await assert.rejects(listModels(null), TypeError);
  let httpErrorCancelled = 0;
  await assert.rejects(
    listModels({
      
      fetch: async () => new Response(new ReadableStream({
        pull() {},
        cancel() {
          httpErrorCancelled += 1;
          throw new Error("injected HTTP cleanup failure");
        },
      }), { status: 503 }),
    }),
    (error) => error instanceof Error && error.message.includes("503") && !error.message.includes("catalog-key"),
  );
  assert.equal(httpErrorCancelled, 1, `${surface} must cancel an HTTP error body without masking the status error`);
  await assert.rejects(
    listModels({  fetch: async () => Response.json({ object: "list" }) }),
    (error) => error instanceof TypeError && error.message.includes("model catalog"),
  );
  let declaredOversizeCancelled = 0;
  await assert.rejects(
    listModels({
      
      fetch: async () => new Response(new ReadableStream({
        pull() {},
        cancel() { declaredOversizeCancelled += 1; },
      }), { headers: { "content-length": String(4 * 1024 * 1024 + 1) } }),
    }),
    (error) => error instanceof RangeError && error.message.includes("4194304"),
  );
  assert.equal(declaredOversizeCancelled, 1, `${surface} must cancel a body rejected by declared size`);
  await assert.rejects(
    listModels({
      
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
        },
        cancel() {
          throw new Error("injected cancellation failure");
        },
      })),
    }),
    (error) => error instanceof RangeError && error.message.includes("4194304"),
  );
}

console.log("explicit Node and browser model discovery passed");
