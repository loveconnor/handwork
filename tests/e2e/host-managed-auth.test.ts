import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandwork } from "../evals/eval-helpers";
import { TmuxSession } from "./tmux-helpers";

const TIMEOUT = 30_000;

type CapturedRequest = {
  path: string;
  method: string;
  headers: Headers;
};

describe("host-managed authentication", () => {
  let root = "";
  let home = "";
  let workspace = "";
  let requests: CapturedRequest[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl = "";
  let codexUnauthorizedResponses = 0;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "handwork-host-managed-auth-"));
    home = join(root, "home");
    workspace = join(root, "workspace");
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push({
          path,
          method: request.method,
          headers: new Headers(request.headers),
        });
        if (path === "/codex/models") {
          return Response.json({ models: [{
            slug: "gpt-5.4-mini",
            visibility: "list",
            supported_in_api: true,
            priority: 1,
            supported_reasoning_levels: [{ effort: "low" }],
            additional_speed_tiers: [],
            input_modalities: ["text"],
            context_window: 272000,
          }, {
            slug: "gpt-5.6-luna",
            visibility: "list",
            supported_in_api: true,
            priority: 2,
            supported_reasoning_levels: [{ effort: "medium" }],
            additional_speed_tiers: [],
            input_modalities: ["text"],
            context_window: 272000,
          }] });
        }
        if (path === "/codex/responses") {
          if (codexUnauthorizedResponses > 0) {
            codexUnauthorizedResponses -= 1;
            return Response.json({ error: { message: "host rejected request" } }, { status: 401 });
          }
          return new Response(
            'data: {"type":"response.output_text.delta","delta":"CODEX_HOST_MANAGED_OK"}\n\n' +
              'data: {"type":"response.completed","response":{"id":"resp_codex_host","status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (path === "/grok/models") {
          return Response.json({ data: [{
            id: "grok-4.20",
            model: "grok-4.20",
            api_backend: "responses",
            context_window: 1000000,
            supports_reasoning_effort: false,
            reasoning_efforts: [],
          }] });
        }
        if (path === "/grok/modalities") {
          return Response.json({ models: [{
            id: "grok-4.20",
            input_modalities: ["text"],
            output_modalities: ["text"],
          }] });
        }
        if (path === "/grok/responses") {
          return new Response(
            'data: {"type":"response.output_text.delta","delta":"GROK_HOST_MANAGED_OK"}\n\n' +
              'data: {"type":"response.completed","response":{"id":"resp_grok_host","status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  });

  function env(): Record<string, string | undefined> {
    return {
      HOME: home,


      HANDWORK_AUTH_MODE: "host-managed",
      HANDWORK_AUTO_UPGRADE: "0",
      HANDWORK_DISABLE_KEYCHAIN: "1",
      HANDWORK_SKIP_ONBOARDING: "1",
      HANDWORK_SOUND: "0",
      HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${baseUrl}/codex/models`,
      HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: `${baseUrl}/codex/responses`,
      HANDWORK_E2E_XAI_GROK_MODELS_URL: `${baseUrl}/grok/models`,
      HANDWORK_E2E_XAI_GROK_MODALITIES_URL: `${baseUrl}/grok/modalities`,
      HANDWORK_E2E_XAI_GROK_RESPONSES_URL: `${baseUrl}/grok/responses`,
    };
  }

  

  test("runs Codex and Grok without local authentication headers", async () => {
    for (const [provider, marker] of [["codex", "CODEX_HOST_MANAGED_OK"], ["grok", "GROK_HOST_MANAGED_OK"]]) {
      const selected = await runHandwork(["provider", provider!], { cwd: workspace, env: env() });
      expect(selected.code).toBe(0);
      const asked = await runHandwork(["ask", "--json", "--no-save", "Reply once."], { cwd: workspace, env: env(), timeoutMs: TIMEOUT });
      expect(asked.code).toBe(0);
      expect(asked.stdout).toContain(marker!);
    }
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      for (const header of ["authorization", "chatgpt-account-id", "x-xai-token-auth", "x-grok-user-id"]) {
        expect(request.headers.get(header), request.path).toBeNull();
      }
    }
    expect(existsSync(join(home, ".handwork", "auth.json"))).toBe(false);
  }, TIMEOUT);

  test("rejects malformed auth mode before provider I/O", async () => {
    const before = requests.length;
    const result = await runHandwork(["ask", "--json", "--no-save", "Do nothing."], {
      cwd: workspace,
      env: { ...env(), HANDWORK_AUTH_MODE: "host_managed" },
      timeoutMs: TIMEOUT,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HANDWORK_AUTH_MODE must be local or host-managed");
    expect(requests.length).toBe(before);
  }, TIMEOUT);

  test("final provider 401 does not enter local refresh or replay", async () => {
    const childEnv = env();
    const selected = await runHandwork(["provider", "codex"], {
      cwd: workspace,
      env: childEnv,
      timeoutMs: TIMEOUT,
    });
    expect(selected.code).toBe(0);

    const before = requests.filter((request) => request.path === "/codex/responses").length;
    codexUnauthorizedResponses = 1;
    const asked = await runHandwork(["ask", "--json", "--no-save", "Reply once."], {
      cwd: workspace,
      env: childEnv,
      timeoutMs: TIMEOUT,
    });
    expect(asked.code).toBe(1);
    const after = requests.filter((request) => request.path === "/codex/responses").length;
    expect(after - before).toBe(1);
    expect(existsSync(join(home, ".handwork", "auth.json"))).toBe(false);
  }, TIMEOUT);

  
});
