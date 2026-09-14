#!/usr/bin/env node
import { routeProviderFetch } from "./fixtures/provider-fetch.mjs";
import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandworkAgent } from "../node.js";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
let modelRequests = 0;
const server = createServer((request, response) => {
  request.resume();
  request.on("end", () => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"object":"list","data":[]}');
      return;
    }
    modelRequests += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"late_1\",\"call_id\":\"late_1\",\"name\":\"late\",\"arguments\":\"{}\"}}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}\n\ndata: [DONE]\n\n");
  });
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

async function withTimeout(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("cancel timed out")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function exerciseLateSettlement(closeBeforeSettle) {
  let toolStartedResolve;
  const toolStarted = new Promise((resolveStarted) => { toolStartedResolve = resolveStarted; });
  let toolResolve;
  let toolSettled = false;
  const settleTool = () => {
    if (toolSettled) return;
    toolSettled = true;
    toolResolve?.("late result");
  };
  let toolSignalAborted = false;
  const events = [];
  const unhandledRejections = [];
  const recordUnhandled = (error) => unhandledRejections.push(error);
  process.on("unhandledRejection", recordUnhandled);

  let agent;
  try {
    agent = await createHandworkAgent({
      backend: "native",
      nativeAddon: resolve(scriptDir, "../../zig-out/lib/libhandwork.node"),
      fetch: routeProviderFetch(function(input,init){
        const url = init.method === "GET" ? `http://127.0.0.1:${server.address().port}/models` : input;
        assert.equal(new URL(url).origin, `http://127.0.0.1:${server.address().port}`);
        return fetch(url, init);
      }, `http://127.0.0.1:${server.address().port}/chat`),
      onEvent(event) { events.push(event); },
      tools: [{
        name: "late",
        description: "Resolve after cancellation",
        inputSchema: { type: "object", properties: {} },
        execute(_input, { signal }) {
          toolStartedResolve();
          signal.addEventListener("abort", () => { toolSignalAborted = true; }, { once: true });
          return new Promise((resolveTool) => { toolResolve = resolveTool; });
        },
      }],
      
      
      model: "late-tool/model",
    });

    const controller = new AbortController();
    const turn = agent.prompt("wait", { signal: controller.signal });
    await toolStarted;
    controller.abort();
    const result = await withTimeout(turn.result);
    assert.equal(result.stopReason, "cancelled");
    assert.equal(toolSignalAborted, true);

    if (closeBeforeSettle) await agent.close();
    const sendsBeforeSettle = events.filter((event) => event.type === "acp.send").length;
    settleTool();
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));

    assert.deepEqual(unhandledRejections, []);
    assert.equal(events.filter((event) => event.type === "acp.send").length, sendsBeforeSettle);
    if (!closeBeforeSettle) await agent.close();
  } finally {
    settleTool();
    await agent?.close().catch(() => {});
    process.off("unhandledRejection", recordUnhandled);
  }
}

try {
  await exerciseLateSettlement(false);
  await exerciseLateSettlement(true);
  assert.equal(modelRequests, 2);
  console.log("native late host-tool completions stayed inert after cancellation and close");
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}
