#!/usr/bin/env node
import { routeProviderFetch } from "./fixtures/provider-fetch.mjs";
import { strict as assert } from "node:assert";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandworkAgent } from "../node.js";

const marker = "LIBHANDWORK_EXPLICIT_HOST_INSTRUCTIONS";
const workspaceMarker = "LIBHANDWORK_WORKSPACE_CONTEXT_MUST_NOT_LOAD";
const originalCwd = process.cwd();
const processWorkspace = await mkdtemp(join(tmpdir(), "libhandwork-process-workspace-"));
const runtimeHome = await mkdtemp(join(tmpdir(), "libhandwork-runtime-home-"));
const runtimeWorkspace = await mkdtemp(join(tmpdir(), "libhandwork-runtime-workspace-"));
const projectMcpMarker = join(runtimeWorkspace, "project-mcp-launched");
await writeFile(join(processWorkspace, ".handwork.json"), `${JSON.stringify({ context: false })}\n`);
await writeFile(join(runtimeWorkspace, ".handwork.json"), `${JSON.stringify({ context: true })}\n`);
await writeFile(join(runtimeWorkspace, "AGENTS.md"), `# Context\n\n${workspaceMarker}\n`);
await writeFile(join(runtimeWorkspace, ".mcp.json"), `${JSON.stringify({
  mcpServers: {
    forbidden: {
      command: "/bin/sh",
      args: ["-c", `printf launched > '${projectMcpMarker}'`],
    },
  },
})}\n`);

let requestBody = "";
let unexpectedRequests = 0;
const server = createServer((request, response) => {
  if (request.method !== "POST") {
    unexpectedRequests++;
    request.resume();
    response.writeHead(404).end();
    return;
  }
  request.setEncoding("utf8");
  request.on("data", (chunk) => { requestBody += chunk; });
  request.on("end", () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"isolated\"}\n\n");
    response.write("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n");
    response.end("data: [DONE]\n\n");
  });
});
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const { port } = server.address();
const previousProviderBase = process.env.HANDWORK_BASE_URL;
process.env.HANDWORK_BASE_URL = `http://127.0.0.1:${port}`;
const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const addon = resolve(process.argv[2] || resolve(scriptDir, "../../zig-out/lib/libhandwork.node"));

let agent;
try {
  process.chdir(processWorkspace);
  agent = await createHandworkAgent({
    nativeAddon: addon,
    backend: "native",
    fetch: routeProviderFetch(function(input,init){
      if (init.method === "GET") {
        assert.equal(input, "https://chatgpt.com/backend-api/codex/models");
        return Response.json({ models: [{ id: "native/test-model", type: "language" }].filter(model => model.type === "language").map(model => ({ slug: model.id, visibility: "list", supported_in_api: true, context_window: 272000, supported_reasoning_levels: [], input_modalities: ["text"] })) });
      }
      assert.equal(init.method, "POST");
      assert.equal(input, `http://127.0.0.1:${port}/chat`);
      return fetch(input, init);
    }, `http://127.0.0.1:${port}/chat`),
    home: runtimeHome,
    workspaceRoot: runtimeWorkspace,
    instructions: marker,
    
    
    model: "native/test-model",
  });
  await assert.rejects(
    access(projectMcpMarker),
    (error) => error?.code === "ENOENT",
    "native addon host must not start workspace MCP",
  );
  const turn = agent.prompt("read the explicit workspace context");
  for await (const _ of turn) {}
  await turn.result;
  assert.match(requestBody, new RegExp(marker), "native startup omitted explicit host instructions");
  assert.doesNotMatch(requestBody, new RegExp(workspaceMarker), "minimal kernel scanned workspace context");
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(await agent.close(), undefined);
  assert.equal(unexpectedRequests, 0, "kernel must not perform native billing lookups outside host fetch");
  console.log("native config isolation passed: explicit instructions, no workspace scan, and no native billing lookup");
} finally {
  await agent?.close();
  if (previousProviderBase === undefined) delete process.env.HANDWORK_BASE_URL;
  else process.env.HANDWORK_BASE_URL = previousProviderBase;
  process.chdir(originalCwd);
  server.closeAllConnections();
  server.close();
  await Promise.all([
    rm(processWorkspace, { recursive: true, force: true }),
    rm(runtimeHome, { recursive: true, force: true }),
    rm(runtimeWorkspace, { recursive: true, force: true }),
  ]);
}
