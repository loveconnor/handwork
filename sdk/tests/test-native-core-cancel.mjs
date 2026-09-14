#!/usr/bin/env node
import { routeProviderFetch } from "./fixtures/provider-fetch.mjs";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandworkAgent } from "../node.js";

let requestStartedResolve;
const requestStarted = new Promise((resolveStarted) => { requestStartedResolve = resolveStarted; });
const server = createServer((request) => {
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/stall");
  request.resume();
  request.once("end", requestStartedResolve);
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const { port } = server.address();
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const addon = resolve(process.argv[2] || resolve(scriptDir, "../../zig-out/lib/libhandwork.node"));
const timeout = (label, ms = 5000) => new Promise((_, reject) => {
  setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
});
try {
  let aborted = false;
  const agent = await createHandworkAgent({
    nativeAddon: addon,
    backend: "native",
    fetch: routeProviderFetch(function(input,init){
      if (init.method === "GET") {
        return Response.json({ models: [{ id: "native/test-model", type: "language" }].filter(model => model.type === "language").map(model => ({ slug: model.id, visibility: "list", supported_in_api: true, context_window: 272000, supported_reasoning_levels: [], input_modalities: ["text"] })) });
      }
      assert.equal(init.method, "POST");
      assert.equal(input, `http://127.0.0.1:${port}/stall`);
      init.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return fetch(input, init);
    }, `http://127.0.0.1:${port}/stall`),
    
    
    model: "native/test-model",
  });
  const turn = agent.prompt("stall");
  await Promise.race([requestStarted, timeout("stalled provider POST")]);
  turn.cancel();
  const result = await Promise.race([turn.result, timeout("native cancellation")]);
  assert.equal(result.stopReason, "cancelled");
  assert.equal(aborted, true, "turn cancellation must abort Node fetch");
  assert.equal(await agent.close(), undefined);
  console.log("native core cancellation passed: stalled request cancelled and runtime closed");
} finally {
  server.closeAllConnections();
  server.close();
}
