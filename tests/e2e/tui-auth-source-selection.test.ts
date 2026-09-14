import { afterEach, expect, test } from "bun:test";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDWORK_BIN, REPO_ROOT, runHandwork, providerVersionTestEnv } from "../evals/eval-helpers";
import { fakeResponsesTitleDefault, TITLE_GENERATION_MARKER } from "./tmux-helpers";
import { readTapeFrames } from "./render-lab/tape";
import { equivalentPngEncodings } from "./fixtures/image-encoding";
import {
  FAKE_CODEX_MODEL,
  fakeCodexFinalText,
  fakeCodexSse,
  startFakeCodex,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const HAS_TMUX = tmuxAvailable();
if (process.env.HANDWORK_REQUIRE_TMUX === "1" && !HAS_TMUX) {
  throw new Error("tmux is required for tui-auth-source-selection.test.ts");
}

const tmuxTest = test.skipIf(!HAS_TMUX);

const TIMEOUT = 30_000;
const ENV_TOKEN = "env-api-key-token";
const LOGIN_TOKEN = "handwork-login-token";

const LOGIN_RESPONSE = "LOGIN_SOURCE_RESPONSE";

const REFRESH_RECOVERY_RESPONSE = "REFRESH_RECOVERY_RESPONSE";
const ACQUIRED_LOGIN_TOKEN = "acquired-login-token";

function grokSubscriptionModel(id: string, contextWindow: number, efforts: string[] = []) {
  return {
    id,
    model: id,
    api_backend: "responses",
    context_window: contextWindow,
    supports_reasoning_effort: efforts.length > 0,
    reasoning_efforts: efforts.map((value) => ({ value })),
  };
}

function grokModalityModel(id: string, vision: boolean) {
  return {
    id,
    input_modalities: vision ? ["text", "image"] : ["text"],
    output_modalities: ["text"],
  };
}

let session: TmuxSession | null = null;
let home: string | null = null;
let stderrPath: string | null = null;
let provider: ReturnType<typeof startFakeCodex> | null = null;

let chatgptOauth: ReturnType<typeof startFakeChatGptOAuth> | null = null;
let catcher: ReturnType<typeof startRequestCatcher> | null = null;

afterEach(async () => {
  await session?.kill();
  session = null;
  provider?.stop();
  provider = null;
  chatgptOauth?.stop();
  chatgptOauth = null;
  catcher?.stop();
  catcher = null;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
  stderrPath = null;
});

function writeSeededChatGptLogin(
  testHome: string,
  accessToken = chatgptAccessToken(),
  expiresAtMs = Date.now() + 60 * 60 * 1000,
): void {
  const handworkDir = join(testHome, ".handwork");
  mkdirSync(handworkDir, { recursive: true, mode: 0o700 });
  chmodSync(handworkDir, 0o700);
  const authPath = join(handworkDir, "chatgpt-auth.json");
  writeFileSync(authPath, JSON.stringify({
    version: 1,
    access_token: accessToken,
    refresh_token: "chatgpt-refresh",
    expires_at_ms: expiresAtMs,
    account_id: "acct_e2e",
  }) + "\n", { mode: 0o600 });
  chmodSync(authPath, 0o600);
}

function writeSeededGrokLogin(
  testHome: string,
  accessToken: string,
  accountId = "acct_grok_e2e",
  expiresAtMs = Date.now() + 60 * 60 * 1000,
): void {
  const handworkDir = join(testHome, ".handwork");
  mkdirSync(handworkDir, { recursive: true, mode: 0o700 });
  chmodSync(handworkDir, 0o700);
  const authPath = join(handworkDir, "grok-auth.json");
  writeFileSync(authPath, JSON.stringify({
    version: 1,
    access_token: accessToken,
    refresh_token: "grok-refresh",
    expires_at_ms: expiresAtMs,
    account_id: accountId,
  }) + "\n", { mode: 0o600 });
  chmodSync(authPath, 0o600);
}

function writeSeededHandworkLogin(
  testHome: string,
  expiresAtMs = Date.now() + 60 * 60 * 1000,
  issuer = "https://auth.handwork.invalid",
  teamId?: string,
): void {
  const handworkDir = join(testHome, ".handwork");
  mkdirSync(handworkDir, { recursive: true, mode: 0o700 });
  chmodSync(handworkDir, 0o700);
  const authPath = join(handworkDir, "auth.json");
  const auth: Record<string, string | number> = {
    version: 1,
    issuer,
    client_id: "test-client",
    access_token: LOGIN_TOKEN,
    refresh_token: "seeded-refresh-token",
    expires_at_ms: expiresAtMs,
    scope: "openid",
    token_type: "Bearer",
  };
  if (teamId) {
    auth.team_id = teamId;
    auth.team_slug = "example-internal-team";
  }
  writeFileSync(authPath, JSON.stringify(auth) + "\n", { mode: 0o600 });
  chmodSync(authPath, 0o600);
}

async function startHandwork(
  testHome: string,
  testStderrPath: string,
  fakeCodex: ReturnType<typeof startFakeCodex>,
  oauthIssuerUrl?: string,
  tracePath?: string,
  envOverrides: Record<string, string | undefined> = {},
  cwd?: string,
  resumeId?: string,
): Promise<TmuxSession> {
  return TmuxSession.create({
    cmd: resumeId ? `${HANDWORK_BIN} --resume '${resumeId}'` : HANDWORK_BIN,
    cwd,
    env: {
      HOME: testHome,
      HANDWORK_AUTH_MODE: "local",

      HANDWORK_DISABLE_KEYCHAIN: "1",
      HANDWORK_SKIP_ONBOARDING: "1",
      HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${fakeCodex.baseUrl}/models`,
      HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: fakeCodex.chatUrl,
      HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${fakeCodex.baseUrl}/models`,
      HANDWORK_MODEL: FAKE_CODEX_MODEL,
      HANDWORK_AUTO_UPGRADE: "0",
      HANDWORK_NO_OPEN_BROWSER: "1",
      HANDWORK_OAUTH_CLIENT_ID: "test-client",
      HANDWORK_E2E_OAUTH_ISSUER_URL: oauthIssuerUrl,
      HANDWORK_TRACE_LOG: tracePath,
      HANDWORK_TRACE_SCOPES: tracePath ? "auth,prompt" : undefined,
      ...envOverrides,
    },
    stderrPath: testStderrPath,
    width: 100,
    height: 30,
  });
}

function chatgptAccessToken(accountId = "acct_e2e"): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function startFakeChatGptOAuth(
  options: {
    tokenDelayMs?: number;
    responseDelayMs?: number;
    unauthorizedResponses?: number;
    rejectRefresh?: boolean;
    beforeRefreshResponse?: () => void | Promise<void>;
    modelsResponse?: () => Promise<Response | void>;
  } = {},
) {
  const accessToken = chatgptAccessToken();
  let responseCount = 0;
  let models = [
    { slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "max" }, { effort: "high" }], additional_speed_tiers: ["fast"], input_modalities: ["text", "image"], context_window: 272000 },
    { slug: "gpt-5.6-luna", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "medium" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 272000 },
    { slug: "gpt-5.4-mini", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "low" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 128000 },
  ];
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
    body: string | null;
  }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = url.pathname === "/chatgpt/responses" || url.pathname === "/chatgpt/token"
        ? await request.text()
        : null;
      if (url.pathname === "/chatgpt/responses" && body?.includes(TITLE_GENERATION_MARKER)) {
        return fakeResponsesTitleDefault();
      }
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body,
      });
      if (url.pathname === "/oauth/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");
        if (!redirectUri || !state) return new Response("invalid authorize request", { status: 400 });
        const callback = new URL(redirectUri.replace("localhost", "127.0.0.1"));
        callback.searchParams.set("code", "chatgpt-code");
        callback.searchParams.set("state", state);
        return Response.redirect(callback.toString(), 302);
      }
      if (url.pathname === "/chatgpt/token") {
        if (options.tokenDelayMs) await Bun.sleep(options.tokenDelayMs);
        const refresh = body?.includes('"grant_type":"refresh_token"') ?? false;
        if (refresh) await options.beforeRefreshResponse?.();
        if (options.rejectRefresh && refresh) {
          return Response.json({ error: { code: "refresh_token_reused" } }, { status: 401 });
        }
        return Response.json({
          access_token: accessToken,
          refresh_token: "chatgpt-refresh",
          expires_in: 3600,
        });
      }
      if (url.pathname === "/chatgpt/models") {
        const overridden = await options.modelsResponse?.();
        return overridden ?? Response.json({ models });
      }
      if (url.pathname === "/chatgpt/responses") {
        responseCount += 1;
        if (responseCount <= (options.unauthorizedResponses ?? 0)) {
          return Response.json(
            { error: { message: "expired ChatGPT token" } },
            { status: 401 },
          );
        }
        if (options.responseDelayMs) await Bun.sleep(options.responseDelayMs);
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"CHATGPT_DIRECT_RESPONSE"}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    accessToken,
    requests,
    env: {
      HANDWORK_E2E_CHATGPT_ISSUER_URL: baseUrl,
      HANDWORK_E2E_CHATGPT_TOKEN_URL: `${baseUrl}/chatgpt/token`,
      HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${baseUrl}/chatgpt/models`,
      HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: `${baseUrl}/chatgpt/responses`,
    },
    baseUrl,
    setModels(next: typeof models) {
      models = next;
    },
    stop() {
      server.stop(true);
    },
  };
}

function startFakeGrokOAuth(options: {
  unauthorizedResponses?: number;
  rejectRefresh?: boolean;
  beforeRefreshResponse?: () => void | Promise<void>;
  revokeStatus?: number;
  userinfoSub?: string;
  modelsResponse?: () => Promise<Response | void>;
} = {}) {
  const initialAccessToken = "grok-initial-access-token";
  const refreshedAccessToken = "grok-refreshed-access-token";
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
    body: string | null;
    conversationId: string | null;
    tokenAuth: string | null;
    authenticateResponse: string | null;
    clientIdentifier: string | null;
    clientVersion: string | null;
    modelOverride: string | null;
    grokUserId: string | null;
    userId: string | null;
    query: string;
  }> = [];
  let tokenCalls = 0;
  let responseCalls = 0;
  let models = [
    { id: "grok-4.20", object: "model", input_modalities: ["text", "image"], output_modalities: ["text"] },
    { id: "grok-4.6", object: "model", input_modalities: ["text", "image"], output_modalities: ["text"] },
    { id: "grok-image-only", object: "model", input_modalities: ["text"], output_modalities: ["image"] },
  ];
  const allSubscriptionModels = [
    grokSubscriptionModel("grok-4.20", 1_000_000),
    grokSubscriptionModel("grok-4.6", 500_000, ["xhigh", "high", "medium", "low"]),
  ];
  let subscriptionModels = allSubscriptionModels;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.text() : null;
      if (url.pathname === "/v1/responses" && body?.includes(TITLE_GENERATION_MARKER)) {
        return fakeResponsesTitleDefault();
      }
      requests.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body,
        conversationId: request.headers.get("x-grok-conv-id"),
        tokenAuth: request.headers.get("x-xai-token-auth"),
        authenticateResponse: request.headers.get("x-authenticateresponse"),
        clientIdentifier: request.headers.get("x-grok-client-identifier"),
        clientVersion: request.headers.get("x-grok-client-version"),
        modelOverride: request.headers.get("x-grok-model-override"),
        grokUserId: request.headers.get("x-grok-user-id"),
        userId: request.headers.get("x-userid"),
        query: url.search,
      });
      if (url.pathname === "/oauth2/authorize") {
        const redirectUri = url.searchParams.get("redirect_uri");
        const state = url.searchParams.get("state");
        if (!redirectUri || !state || url.searchParams.get("nonce")) {
          return new Response("invalid authorize request", { status: 400 });
        }
        if (url.searchParams.get("referrer") !== "handwork") {
          return new Response("missing handwork referrer", { status: 400 });
        }
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", "grok-code");
        callback.searchParams.set("state", state);
        return Response.redirect(callback.toString(), 302);
      }
      if (url.pathname === "/oauth2/token") {
        tokenCalls += 1;
        const form = new URLSearchParams(body ?? "");
        const refresh = form.get("grant_type") === "refresh_token";
        if (refresh) await options.beforeRefreshResponse?.();
        if (refresh && options.rejectRefresh) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return Response.json({
          access_token: refresh ? refreshedAccessToken : initialAccessToken,
          refresh_token: refresh ? "grok-refresh-next" : "grok-refresh",
          expires_in: 3600,
        });
      }
      if (url.pathname === "/oauth2/userinfo") {
        if (!request.headers.get("authorization")?.startsWith("Bearer grok-")) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        return Response.json({ sub: options.userinfoSub ?? "acct_grok_e2e" });
      }
      if (url.pathname === "/oauth2/revoke") {
        const form = new URLSearchParams(body ?? "");
        const valid = form.get("client_id") === "b1a00492-073a-47ea-816f-4c329264a828" &&
          (form.get("token") === "grok-refresh-next" || form.get("token") === "grok-refresh");
        if (valid && options.revokeStatus && options.revokeStatus !== 200) {
          return Response.json({ error: "revocation unavailable" }, { status: options.revokeStatus });
        }
        return Response.json(valid ? { revoked: true } : { error: "invalid" }, {
          status: valid ? 200 : 400,
        });
      }
      if (url.pathname === "/v1/language-models") {
        return Response.json({ models });
      }
      if (url.pathname === "/v1/models") {
        const overridden = await options.modelsResponse?.();
        return overridden ?? Response.json({ data: subscriptionModels });
      }
      if (url.pathname === "/v1/responses") {
        responseCalls += 1;
        if (responseCalls <= (options.unauthorizedResponses ?? 0)) {
          return Response.json({ error: { message: "expired" } }, { status: 401 });
        }
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"GROK_DIRECT_RESPONSE"}\n\n' +
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    initialAccessToken,
    refreshedAccessToken,
    requests,
    tokenCalls: () => tokenCalls,
    baseUrl,
    env: {
      HANDWORK_E2E_GROK_ISSUER_URL: baseUrl,
      HANDWORK_E2E_GROK_TOKEN_URL: `${baseUrl}/oauth2/token`,
      HANDWORK_E2E_GROK_USERINFO_URL: `${baseUrl}/oauth2/userinfo`,
      HANDWORK_E2E_GROK_REVOKE_URL: `${baseUrl}/oauth2/revoke`,
      HANDWORK_E2E_XAI_GROK_MODELS_URL: `${baseUrl}/v1/models`,
      HANDWORK_E2E_XAI_GROK_MODALITIES_URL: `${baseUrl}/v1/language-models`,
      HANDWORK_E2E_XAI_GROK_RESPONSES_URL: `${baseUrl}/v1/responses`,
    },
    setModels(next: typeof models) {
      models = next;
      const visibleIds = new Set(next.map((model) => model.id));
      subscriptionModels = allSubscriptionModels.filter((model) => visibleIds.has(model.id));
    },
    stop() { server.stop(true); },
  };
}

async function completeDisplayedGrokLogin(
  activeSession: TmuxSession,
  fixture: ReturnType<typeof startFakeGrokOAuth>,
) {
  await completeDisplayedSubscriptionLogin(
    activeSession,
    "Authorize with Grok",
    `${fixture.baseUrl}/oauth2/authorize?`,
  );
}

async function completeDisplayedCodexLogin(
  activeSession: TmuxSession,
  fixture: ReturnType<typeof startFakeChatGptOAuth>,
) {
  await completeDisplayedSubscriptionLogin(
    activeSession,
    "Authorize with Codex",
    `${fixture.baseUrl}/oauth/authorize?`,
  );
}

async function completeDisplayedSubscriptionLogin(
  activeSession: TmuxSession,
  label: string,
  authorizationUrlPrefix: string,
  expectedStatus = 200,
) {
  await activeSession.waitForText(label, TIMEOUT);
  const escapes = await activeSession.capturePaneEscapes();
  const urlStart = escapes.indexOf(authorizationUrlPrefix);
  const linkStart = escapes.lastIndexOf("\x1b]8;", urlStart);
  const urlEnd = escapes.indexOf("\x1b\\", urlStart);
  if (urlStart < 0 || linkStart < 0 || urlEnd < 0) {
    throw new Error(`${label} hyperlink was not rendered`);
  }
  const authorizationUrl = escapes.slice(urlStart, urlEnd);
  const response = await fetch(authorizationUrl, { redirect: "follow" });
  expect(response.status).toBe(expectedStatus);
}

function startFakeCodexToolLoop(options: {
  responses?: Response[];
  model?: string;
  toolCallId?: string;
  toolName?: string;
  toolArguments?: object;
  finalText?: string;
  inputModalities?: string[];
} = {}) {
  const bodies: string[] = [];
  const accessToken = chatgptAccessToken("acct_tool_loop");
  const toolName = options.toolName ?? "read_file";
  const toolArguments = options.toolArguments ?? { path: "README.md" };
  const finalText = options.finalText ?? "CODEX_TOOL_LOOP_OK";
  const inputModalities = options.inputModalities ?? ["text"];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/models") {
        return Response.json({ models: [
          { slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "high" }], additional_speed_tiers: [], input_modalities: inputModalities, context_window: 272000 },
          { slug: "gpt-5.6-luna", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "medium" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 272000 },
          { slug: "gpt-5.4-mini", visibility: "list", supported_in_api: true, supported_reasoning_levels: [{ effort: "low" }], additional_speed_tiers: [], input_modalities: ["text"], context_window: 128000 },
        ].map((model, index) => index === 0 && options.model ? { ...model, slug: options.model } : model) });
      }
      const titleBody = await request.text();
      if (titleBody.includes(TITLE_GENERATION_MARKER)) return fakeResponsesTitleDefault();
      bodies.push(titleBody);
      if (options.responses) return options.responses.shift() ?? new Response("unexpected request", { status: 400 });
      if (bodies.length === 1) {
        return new Response(
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning"}}\n\n' +
            'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_tool","type":"reasoning","summary":[],"encrypted_content":"opaque-tool-loop"}}\n\n' +
            `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: options.toolCallId ?? "call_tool", name: toolName } })}\n\n` +
            `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, arguments: JSON.stringify(toolArguments) })}\n\n` +
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: finalText })}\n\n` +
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    accessToken,
    bodies,
    responsesUrl: `http://127.0.0.1:${server.port}/responses`,
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    stop() { server.stop(true); },
  };
}

function startFakeGrokToolLoop(options: {
  responses?: Response[];
  model?: string;
  toolCallId?: string;
  toolName?: string;
  toolArguments?: object;
  finalText?: string;
} = {}) {
  const bodies: string[] = [];
  const accessToken = "grok-tool-loop-token";
  const toolName = options.toolName ?? "read_file";
  const toolArguments = options.toolArguments ?? { path: "README.md" };
  const finalText = options.finalText ?? "GROK_TOOL_LOOP_OK";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/models") {
        return Response.json({ data: [grokSubscriptionModel(options.model ?? "grok-4.20", 1_000_000)] });
      }
      if (path === "/modalities") {
        return Response.json({ models: [grokModalityModel(options.model ?? "grok-4.20", true)] });
      }
      const titleBody = await request.text();
      if (titleBody.includes(TITLE_GENERATION_MARKER)) return fakeResponsesTitleDefault();
      bodies.push(titleBody);
      if (options.responses) return options.responses.shift() ?? new Response("unexpected request", { status: 400 });
      if (bodies.length === 1) {
        return new Response(
          'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning"}}\n\n' +
            'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_tool","type":"reasoning","summary":[],"encrypted_content":"opaque-grok-tool-loop"}}\n\n' +
            `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: options.toolCallId ?? "call_tool", name: toolName } })}\n\n` +
            `data: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: 1, arguments: JSON.stringify(toolArguments) })}\n\n` +
            'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: finalText })}\n\n` +
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":7,"output_tokens":3}}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    accessToken,
    bodies,
    responsesUrl: `http://127.0.0.1:${server.port}/responses`,
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    modalitiesUrl: `http://127.0.0.1:${server.port}/modalities`,
    stop() { server.stop(true); },
  };
}

function startFakeGrokResourceRecovery() {
  const accessToken = "grok-resource-limit-token";
  const bodies: string[] = [];
  let responseCalls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/models") {
        return Response.json({ data: [grokSubscriptionModel("grok-4.20", 500_000)] });
      }
      if (path === "/modalities") {
        return Response.json({ models: [grokModalityModel("grok-4.20", false)] });
      }
      const titleBody = await request.text();
      if (titleBody.includes(TITLE_GENERATION_MARKER)) return fakeResponsesTitleDefault();
      bodies.push(titleBody);
      responseCalls += 1;
      if (responseCalls === 1) {
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"' +
            "x".repeat(1024 * 1024) +
            '"}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const text = responseCalls === 2 ? "GROK_LIMIT_RECOVERED" : "GROK_AFTER_LIMIT_OK";
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n` +
          'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    accessToken,
    bodies,
    responsesUrl: `http://127.0.0.1:${server.port}/responses`,
    modelsUrl: `http://127.0.0.1:${server.port}/models`,
    modalitiesUrl: `http://127.0.0.1:${server.port}/modalities`,
    stop() { server.stop(true); },
  };
}

for (const subscription of ["codex", "grok"] as const) {
  tmuxTest(`provider recovery activates ${subscription} sign-in after a cancelled turn`, async () => {
    home = mkdtempSync(join(tmpdir(), `handwork-cancel-login-${subscription}-`));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    provider = startFakeCodex([async () => {
      await held;
      return fakeCodexFinalText("CANCELLED_PROVIDER_RESPONSE");
    }]);
    chatgptOauth = startFakeChatGptOAuth();
    const grok = startFakeGrokOAuth();
    try {
      session = await startHandwork(home, stderrPath, provider, undefined, undefined, {
        ...chatgptOauth.env, ...grok.env, HANDWORK_MODEL: undefined,
      });
      await session.waitForComposer(TIMEOUT);
      await session.sendText("Hold this request until cancelled.");
      const deadline = Date.now() + TIMEOUT;
      while (provider.requests.length === 0) {
        if (Date.now() > deadline) throw new Error("Provider request did not start");
        await Bun.sleep(20);
      }
      await session.sendKeys("C-c");
      await session.waitForText("What can handwork do differently?", TIMEOUT);
      release();
      await openProviderPicker(session);
      await session.sendKeys("Down");
      if (subscription === "grok") await session.sendKeys("Down");
      await session.sendKeys("Enter");
      if (subscription === "codex") await completeDisplayedCodexLogin(session, chatgptOauth);
      else await completeDisplayedGrokLogin(session, grok);
      const label = subscription === "codex" ? "Codex" : "Grok";
      const outcome = await session.waitForPane(
        (pane) => pane.includes(`Switched to ${label} subscription`) ||
          pane.includes("Subscription sign-in completed, but"),
        TIMEOUT,
      );
      expect(outcome).toContain(`Switched to ${label} subscription`);
      await session.sendText("Use the subscription immediately after sign-in.");
      await session.waitForText(subscription === "codex" ? "CHATGPT_DIRECT_RESPONSE" : "GROK_DIRECT_RESPONSE", TIMEOUT);
      expect(provider.requests).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(home, ".handwork", "settings.json"), "utf8")).provider).toBe(provider);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      release();
      grok.stop();
    }
  }, 60_000);
}

for (const providerState of ["absent", "rejected"] as const) {
  
}

for (const otherProvider of ["codex", "grok"] as const) {
  
}

tmuxTest("provider recovery refuses active logout before deleting a busy subscription", async () => {
  home = mkdtempSync(join(tmpdir(), "handwork-logout-busy-"));
  stderrPath = join(home, "stderr.log");
  writeFileSync(stderrPath, "");
  provider = startFakeCodex([]);
  chatgptOauth = startFakeChatGptOAuth({ responseDelayMs: 10_000 });
  writeSeededChatGptLogin(home, chatgptOauth.accessToken);
  const authPath = join(home, ".handwork", "chatgpt-auth.json");
  writeFileSync(join(home, ".handwork", "settings.json"), JSON.stringify({
    provider: "codex", models: { codex: "gpt-5.6-sol" },
  }), { mode: 0o600 });
  session = await startHandwork(home, stderrPath, provider, undefined, undefined, {
    ...chatgptOauth.env, HANDWORK_MODEL: undefined,
  });
  await session.waitForComposer(TIMEOUT);
  await session.sendText("Keep this response open.");
  const deadline = Date.now() + TIMEOUT;
  while (!chatgptOauth.requests.some((request) => request.path === "/chatgpt/responses")) {
    if (Date.now() > deadline) throw new Error("Codex request did not start");
    await Bun.sleep(20);
  }
  await session.sendText("/logout");
  const outcome = await session.waitForPane(
    (pane) => pane.includes("Sign out is unavailable until active and queued work finishes.") ||
      pane.includes("Signed out of Codex."),
    TIMEOUT,
  );
  expect(outcome).toContain("Sign out is unavailable until active and queued work finishes.");
  expect(existsSync(authPath)).toBe(true);
  await session.sendKeys("C-c");
  await session.waitForText("What can handwork do differently?", TIMEOUT);
  expect(readFileSync(stderrPath, "utf8")).toBe("");
}, 60_000);

for (const command of ["/provider", "/login", "/setup"]) {
  tmuxTest(`provider picker retains type-ahead after ${command} Enter`, async () => {
    home = mkdtempSync(join(tmpdir(), "handwork-provider-typeahead-"));
    stderrPath = join(home, "stderr.log");
    provider = startFakeCodex([]);
    session = await startHandwork(home, stderrPath, provider);
    await session.waitForComposer(TIMEOUT);

    await session.sendLiteral(`${command}\rcodex`);
    const prefix = command === "/login" ? "/login" : "/provider";
    await session.waitForPane(
      (pane) => pane.split("\n").some((line) => line.trim() === `┃ ${prefix} codex`) && /^\s+codex\s*$/m.test(pane),
      TIMEOUT,
    );
    await session.sendKeys("BSpace");
    await session.waitForPane(
      (pane) => pane.split("\n").some((line) => line.trim() === `┃ ${prefix} code`),
      TIMEOUT,
    );
    await session.sendKeys("Escape");
    await session.sendKeys("C-u");
    await session.sendLiteral("retained draft");
    await session.waitForText("retained draft", TIMEOUT);
    expect(provider.requests).toHaveLength(0);
    expect(await session.captureFullScrollback()).not.toContain("Authorize with Codex");
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  }, TIMEOUT * 2);
}

tmuxTest("provider picker consumes selection keys while inventory is pending", async () => {
  home = mkdtempSync(join(tmpdir(), "handwork-provider-pending-"));
  stderrPath = join(home, "stderr.log");
  provider = startFakeCodex([]);
  chatgptOauth = startFakeChatGptOAuth();
  session = await startHandwork(home, stderrPath, provider, undefined, undefined, chatgptOauth.env);
  await session.waitForComposer(TIMEOUT);

  await session.sendLiteral("/provider\rco\t\r");
  await session.waitForPane(
    (pane) => pane.split("\n").some((line) => line.trim() === "┃ /provider co") && /^\s+codex\s*$/m.test(pane),
    TIMEOUT,
  );
  expect(provider.requests).toHaveLength(0);
  expect(chatgptOauth.requests).toHaveLength(0);
  await session.sendKeys("Tab");
  await session.waitForText("/provider codex", TIMEOUT);
  await session.sendKeys("Escape");
  await session.sendKeys("C-u");
  expect(readFileSync(stderrPath, "utf8")).toBe("");
}, TIMEOUT * 2);

for (const scenario of [
  { name: "bare provider", command: "/provider" },
  { name: "setup alias", command: "/setup" },
  { name: "login alias", command: "/login" },
  { name: "typed provider query", command: "/provider " },
]) {
  tmuxTest(`first Enter reports busy provider flow for ${scenario.name}`, async () => {
    home = mkdtempSync(join(tmpdir(), "handwork-provider-picker-busy-"));
    stderrPath = join(home, "stderr.log");
    let cancelled = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const encoder = new TextEncoder();
    provider = startFakeCodex([() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("data: {\"type\":\"response.output_text.delta\",\"delta\":\"The response remains active.\\n\\n\"}\n\n"));
        heartbeat = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 100);
      },
      cancel() {
        cancelled = true;
        clearInterval(heartbeat);
      },
    }), { headers: { "content-type": "text/event-stream" } })]);
    try {
      session = await startHandwork(home, stderrPath, provider);
      await session.waitForComposer(TIMEOUT);
      await session.sendText("Keep the response active while I inspect provider settings.");
      await session.waitForText("Generating", TIMEOUT);

      await session.sendText(scenario.command);
      const notice = "Provider switching is unavailable until active and queued work finishes.";
      await session.waitForText(notice, TIMEOUT);
      const scrollback = await session.captureFullScrollback();
      expect(scrollback.split(notice)).toHaveLength(2);
      expect(cancelled).toBe(false);
      expect(provider.requests).toHaveLength(1);

      await session.sendKeys("C-u");
      await session.sendInterruptEscapePair(TIMEOUT);
      await session.waitForText("What can handwork do differently?", TIMEOUT);
      await session.sendText(scenario.command.trim());
      await session.waitForPane(
        (pane) => pane.includes("codex") && pane.includes("grok"),
        TIMEOUT,
      );
      expect(cancelled).toBe(true);
      expect(provider.requests).toHaveLength(1);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      clearInterval(heartbeat);
    }
  }, TIMEOUT * 2);
}

tmuxTest(
  "browser authorization reports a failed save without activating the provider",
  async () => {
    home = mkdtempSync(join(tmpdir(), "handwork-auth-callback-save-failure-"));
    stderrPath = join(home, "stderr.log");
    provider = startFakeCodex([fakeCodexFinalText("PROVIDER_AFTER_FAILED_SIGNIN")]);
    chatgptOauth = startFakeChatGptOAuth();
    const grok = startFakeGrokOAuth();
    try {
      session = await startHandwork(home, stderrPath, provider, undefined, undefined, {
        ...chatgptOauth.env,
        ...grok.env,
      });
      await session.waitForComposer(TIMEOUT);
      for (const [provider, label] of [["codex", "Codex"], ["grok", "Grok"]]) {
        await openProviderPicker(session);
        await session.sendText(provider);
        await session.waitForText(`Authorize with ${label}`, TIMEOUT);
        if (provider === "codex") writeSeededChatGptLogin(home);
        else writeSeededGrokLogin(home, grok.initialAccessToken);
        const name = provider === "codex" ? "chatgpt-auth.json" : "grok-auth.json";
        const original = join(home, ".handwork", name);
        linkSync(original, join(home, `${name}.alias`));
        await completeDisplayedSubscriptionLogin(
          session,
          `Authorize with ${label}`,
          provider === "codex" ? `${chatgptOauth.baseUrl}/oauth/authorize?` : `${grok.baseUrl}/oauth2/authorize?`,
          400,
        );
        await session.waitForText(`${label} subscription: Credential could not be saved`, TIMEOUT);
        expect(await session.captureFullScrollback()).not.toContain(`Switched to ${label}`);
        expect(statSync(original).nlink).toBe(2);
        expect(readFileSync(original, "utf8")).toBe(readFileSync(join(home, `${name}.alias`), "utf8"));
        await session.waitForComposer(TIMEOUT);
      }
      await session.sendText("Use the original Provider credential.");
      await session.waitForText("PROVIDER_AFTER_FAILED_SIGNIN", TIMEOUT);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      grok.stop();
    }
  },
  60_000,
);

tmuxTest(
  "unavailable saved subscription reports storage failure and recovers after repair",
  async () => {
    home = mkdtempSync(join(tmpdir(), "handwork-auth-unavailable-signin-"));
    stderrPath = join(home, "stderr.log");
    writeSeededChatGptLogin(home);
    writeSeededGrokLogin(home, "grok-initial-access-token");
    for (const name of ["chatgpt-auth.json", "grok-auth.json"]) {
      linkSync(join(home, ".handwork", name), join(home, `${name}.alias`));
    }
    provider = startFakeCodex([]);
    chatgptOauth = startFakeChatGptOAuth();
    const grok = startFakeGrokOAuth();
    try {
      session = await startHandwork(home, stderrPath, provider, undefined, undefined, {
        ...chatgptOauth.env,
        ...grok.env,
      });
      await session.waitForComposer(TIMEOUT);
      for (const [provider, label] of [["codex", "Codex"], ["grok", "Grok"]]) {
        await openProviderPicker(session);
        await session.sendText(provider);
        await session.waitForText(`${label} subscription: Saved credential storage is unavailable`, 10_000);
        const blocked = await session.captureFullScrollback();
        expect(blocked).not.toContain(`Authorize with ${label}`);
        expect(blocked).not.toContain(`Switched to ${label}`);
        await session.waitForComposer(TIMEOUT);

        const name = provider === "codex" ? "chatgpt-auth.json" : "grok-auth.json";
        const original = join(home, ".handwork", name);
        expect(statSync(original).nlink).toBe(2);
        expect(readFileSync(original, "utf8")).toBe(readFileSync(join(home, `${name}.alias`), "utf8"));
        unlinkSync(join(home, `${name}.alias`));
        await openProviderPicker(session);
        await session.sendText(provider);
        await session.waitForText(`Switched to ${label} subscription`, TIMEOUT);
        await session.sendText(`Use the saved ${label} credential.`);
        await session.waitForText(provider === "codex" ? "CHATGPT_DIRECT_RESPONSE" : "GROK_DIRECT_RESPONSE", TIMEOUT);
      }
      for (const name of ["chatgpt-auth.json", "grok-auth.json"]) {
        expect(statSync(join(home, ".handwork", name)).nlink).toBe(1);
      }
      expect(session.isAlive()).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      grok.stop();
    }
  },
  60_000,
);

tmuxTest(
  "Codex sign-in renders browser OAuth without a device code and cancels cleanly",
  async () => {
    home = mkdtempSync(join(tmpdir(), "handwork-tui-chatgpt-cancel-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    provider = startFakeCodex([]);
    chatgptOauth = startFakeChatGptOAuth();

    session = await startHandwork(
      home,
      stderrPath,
      provider,
      undefined,
      undefined,
      chatgptOauth.env,
    );
    await session.waitForComposer(TIMEOUT);
    await session.sendText("/login");
    await session.waitForPane(
      (pane) => pane.includes("codex") && pane.includes("grok"),
      TIMEOUT,
    );
    await session.sendLiteral("codex");
    await session.sendKeys("Enter");
    const signInScreen = await session.waitForPane(
      (pane) =>
        pane.includes("Sign in with Codex") &&
        pane.includes("Authorize with Codex") &&
        pane.includes("Waiting for authorization") &&
        pane.includes("enter reopens browser · esc cancels"),
      TIMEOUT,
    );
    expect(signInScreen).toMatch(/^Sign in with Codex\s+Waiting for authorization…$/m);
    expect(signInScreen).toMatch(/^  Open\s+Authorize with Codex$/m);
    expect(signInScreen).toMatch(/^enter reopens browser · esc cancels$/m);
    expect(signInScreen).not.toContain("Code   ");
    expect(signInScreen).not.toContain(`${chatgptOauth.baseUrl}/oauth/authorize?`);
    const signInEscapes = await session.capturePaneEscapes();
    expect(signInEscapes).toContain(`\x1b]8;;${chatgptOauth.baseUrl}/oauth/authorize?`);
    expect(signInEscapes).toContain("\x1b]8;;\x1b\\");
    await session.sendKeys("C-c");
    await session.waitForComposer(TIMEOUT);

    expect(session.isAlive()).toBe(true);
    expect(existsSync(join(home, ".handwork", "chatgpt-auth.json"))).toBe(false);
    expect(await session.captureFullScrollback()).not.toContain("Signed in with Codex.");
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  },
  60_000,
);

tmuxTest(
  "interactive Codex login activates a Codex catalog model",
  async () => {
    home = mkdtempSync(join(tmpdir(), "handwork-tui-chatgpt-login-activation-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    provider = startFakeCodex([]);
    chatgptOauth = startFakeChatGptOAuth();

    session = await startHandwork(
      home,
      stderrPath,
      provider,
      undefined,
      undefined,
      { ...chatgptOauth.env, HANDWORK_MODEL: undefined },
    );
    await session.waitForComposer(TIMEOUT);
    await session.sendText("/login");
    await session.waitForPane(
      (pane) => pane.includes("codex") && pane.includes("grok"),
      TIMEOUT,
    );
    await session.sendLiteral("codex");
    await session.sendKeys("Enter");
    await completeDisplayedCodexLogin(session, chatgptOauth);
    await session.waitForText("Switched to Codex subscription with gpt-5.6-sol.", TIMEOUT);

    const selected = JSON.parse(readFileSync(join(home, ".handwork", "settings.json"), "utf8"));
    expect(selected.provider).toBe("codex");
    expect(selected.models.codex).toBe("gpt-5.6-sol");
    await session.sendText("/status");
    await session.waitForText("model_source=Codex subscription", TIMEOUT);
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  },
  60_000,
);

tmuxTest(
  "ChatGPT response transport cancels blocked HTTP without stopping the shell",
  async () => {
    home = mkdtempSync(join(tmpdir(), "handwork-tui-chatgpt-response-cancel-"));
    stderrPath = join(home, "stderr.log");
    writeFileSync(stderrPath, "");
    provider = startFakeCodex([]);
    chatgptOauth = startFakeChatGptOAuth({ responseDelayMs: 10_000 });
    writeSeededChatGptLogin(home, chatgptOauth.accessToken);
    writeFileSync(
      join(home, ".handwork", "settings.json"),
      JSON.stringify({ provider: "codex", codex_model: "gpt-5.6-sol" }) + "\n",
      { mode: 0o600 },
    );

    session = await startHandwork(
      home,
      stderrPath,
      provider,
      undefined,
      undefined,
      {
        ...chatgptOauth.env,
        HANDWORK_MODEL: undefined,
      },
    );
    await session.waitForComposer(TIMEOUT);
    await session.sendText("Cancel the blocked Codex response.");
    await Bun.sleep(300);
    const cancelStarted = Date.now();
    await session.sendKeys("C-c");
    const cancelledPane = await session.waitForText(
      "What can handwork do differently?",
      TIMEOUT,
    );
    await session.waitForComposer(TIMEOUT);
    expect(Date.now() - cancelStarted).toBeLessThan(500);
    expect(cancelledPane).toContain("■ Cancelled");
    expect(cancelledPane).not.toContain("System: cancelled");
    expect(cancelledPane).not.toContain("Cancelling");
    expect(session.isAlive()).toBe(true);
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  },
  60_000,
);

for (const [provider, help] of [
  ["codex", "Codex needs a subscription login."],
  ["grok", "Grok needs a subscription login."],
] as const) {
  
}

for (const [source, help] of [
] as const) {
  
}

async function waitForTrace(
  tracePath: string,
  needle: string,
  timeoutMs = TIMEOUT,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(tracePath) && readFileSync(tracePath, "utf8").includes(needle)) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for trace: ${needle}`);
}

async function openProviderPicker(pickerSession: TmuxSession): Promise<void> {
  await pickerSession.sendText("/provider");
  await pickerSession.waitForPane(
    (pane) => pane.includes("codex") && pane.includes("grok"),
    TIMEOUT,
  );
}

// The inline picker replaced the hub's Credential source screen. Selecting the
// handwork login now goes through the oauth method; with no teams to refine it, the
// choice commits the credential directly.


// Selecting the environment key goes through the api-key method's which-key
// column, which lists it as `env`.


test("Grok logout removes local credentials when remote revocation fails", async () => {
  home = mkdtempSync(join(tmpdir(), "handwork-grok-logout-revoke-failure-"));
  const grok = startFakeGrokOAuth({ revokeStatus: 503 });
  try {
    writeSeededGrokLogin(home, grok.initialAccessToken);
    writeFileSync(
      join(home, ".handwork", "settings.json"),
      JSON.stringify({ provider: "grok", grok_model: "grok-4.20" }) + "\n",
      { mode: 0o600 },
    );
    const authPath = join(home, ".handwork", "grok-auth.json");
    const result = await runHandwork(["logout", "grok"], {
      env: {
        HOME: home,
        HANDWORK_DISABLE_KEYCHAIN: "1",
        HANDWORK_AUTO_UPGRADE: "0",
        HANDWORK_E2E_GROK_REVOKE_URL: grok.env.HANDWORK_E2E_GROK_REVOKE_URL,
      },
      timeoutMs: TIMEOUT,
    });
    expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Signed out of Grok.");
    expect(result.stderr).toContain("remote revocation could not be confirmed");
    expect(existsSync(authPath)).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".handwork", "settings.json"), "utf8")).provider)
      .toBe("grok");
    const ask = await runHandwork(["ask", "--json", "--no-save", "Still Grok?"], {
      env: { HOME: home, HANDWORK_DISABLE_KEYCHAIN: "1", HANDWORK_AUTO_UPGRADE: "0" },
      timeoutMs: TIMEOUT,
    });
    expect(ask.code).toBe(1);
    expect(ask.stderr).toContain("handwork login grok");
  } finally {
    grok.stop();
  }
});

test("Grok logout removes malformed and unsafe local credentials", async () => {
  home = mkdtempSync(join(tmpdir(), "handwork-grok-logout-unreadable-"));
  const grok = startFakeGrokOAuth();
  try {
    const authPath = join(home, ".handwork", "grok-auth.json");
    for (const failure of ["malformed", "unsafe"]) {
      writeSeededGrokLogin(home, grok.initialAccessToken);
      if (failure === "malformed") writeFileSync(authPath, "{invalid-json");
      else chmodSync(authPath, 0o644);

      const result = await runHandwork(["logout", "grok"], {
        env: {
          HOME: home,
          HANDWORK_DISABLE_KEYCHAIN: "1",
          HANDWORK_AUTO_UPGRADE: "0",
          HANDWORK_E2E_GROK_REVOKE_URL: grok.env.HANDWORK_E2E_GROK_REVOKE_URL,
        },
        timeoutMs: TIMEOUT,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Signed out of Grok.");
      expect(result.stderr).toContain("remote revocation could not be confirmed");
      expect(existsSync(authPath)).toBe(false);
      expect(grok.requests).toHaveLength(0);
      expect(result.stderr).not.toContain(grok.initialAccessToken);
    }
  } finally {
    grok.stop();
  }
});

tmuxTest(
  "interactive Grok login auto-expands for a bracketed-paste authorization code",
  async () => {
    home = mkdtempSync(join(tmpdir(), "handwork-grok-tui-code-"));
    stderrPath = join(home, "stderr.log");
    provider = startFakeCodex([]);
    const grok = startFakeGrokOAuth();
    try {
      session = await startHandwork(home, stderrPath, provider, undefined, undefined, {
        HANDWORK_MODEL: undefined,
        ...grok.env,
      });
      await session.waitForComposer(TIMEOUT);
      await session.sendText("/login");
      await session.waitForPane(
        (pane) => pane.includes("codex") && pane.includes("grok"),
        TIMEOUT,
      );
      await session.sendLiteral("grok");
      await session.sendKeys("Enter");
      await session.waitForText("Browser didn't return? press tab to enter a code", TIMEOUT);
      await session.pasteText("grok-code");
      await session.waitForPane(
        (pane) => pane.includes("•••••••••") && pane.includes("enter submits"),
        TIMEOUT,
      );
      const expanded = await session.capturePane();
      expect(expanded).toMatch(/^  Open\s+Authorize with Grok\n\s*\n  Paste the code shown by xAI$/m);
      await session.resizeWindow(80, 5);
      const compactEntry = await session.waitForPane(
        (pane) =>
          pane.includes("•••••••••") &&
          pane.includes("enter submits") &&
          pane.includes("esc cancels"),
        TIMEOUT,
      );
      expect(compactEntry).not.toContain("Paste the code shown by xAI");
      await session.sendKeys("Tab");
      const collapsedWithDraft = await session.waitForText("tab enters code", TIMEOUT);
      expect(collapsedWithDraft).not.toContain("•••••••••");
      await session.sendKeys("Tab");
      await session.waitForPane(
        (pane) => pane.includes("•••••••••") && pane.includes("enter submits"),
        TIMEOUT,
      );
      await session.sendKeys("Enter");
      await session.waitForText("Switched to Grok subscription with grok-4.20.", TIMEOUT);

      const scrollback = await session.captureFullScrollback();
      expect(scrollback).not.toContain("grok-code");
      expect(grok.tokenCalls()).toBe(1);
      expect(existsSync(join(home, ".handwork", "grok-auth.json"))).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      grok.stop();
    }
  },
  60_000,
);

tmuxTest(
  "Grok model selection uses provider-advertised context and effort metadata",
  async () => {
    home = mkdtempSync(join(tmpdir(), "handwork-grok-effort-selection-"));
    stderrPath = join(home, "stderr.log");
    provider = startFakeCodex([]);
    const grok = startFakeGrokOAuth();
    try {
      writeSeededGrokLogin(home, grok.initialAccessToken);
      writeFileSync(
        join(home, ".handwork", "settings.json"),
        JSON.stringify({ provider: "grok", grok_model: "grok-4.20", statusLine: { context: true } }) + "\n",
        { mode: 0o600 },
      );
      session = await startHandwork(home, stderrPath, provider, undefined, undefined, {
        HANDWORK_MODEL: undefined,
        ...grok.env,
      });
      await session.waitForComposer(TIMEOUT);
      const catalogDeadline = Date.now() + TIMEOUT;
      while (!grok.requests.some((request) => request.path === "/v1/language-models")) {
        if (Date.now() >= catalogDeadline) throw new Error("Grok catalog did not load");
        await Bun.sleep(25);
      }
      await session.sendText("/model grok-4.6 xhigh");
      await session.waitForText("Switched to grok-4.6", TIMEOUT);
      await session.sendText("Use the selected effort.");
      await session.waitForText("GROK_DIRECT_RESPONSE", TIMEOUT);

      const response = grok.requests.find((request) => request.path === "/v1/responses");
      expect(response).toBeDefined();
      const body = JSON.parse(response!.body ?? "{}") as {
        model?: string;
        reasoning?: { effort?: string };
      };
      expect(body.model).toBe("grok-4.6");
      expect(body.reasoning?.effort).toBe("xhigh");
      expect(await session.capturePane()).toContain("/500k");
      expect(readFileSync(join(home, ".handwork", "settings.json"), "utf8")).toContain('"effort":"xhigh"');
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      grok.stop();
    }
  },
  60_000,
);

tmuxTest(
  "Grok resource exhaustion stays on-provider and leaves later input usable",
  async () => {
    home = mkdtempSync(join(tmpdir(), "handwork-grok-resource-recovery-"));
    stderrPath = join(home, "stderr.log");
    provider = startFakeCodex([]);
    const grok = startFakeGrokResourceRecovery();
    try {
      writeSeededGrokLogin(home, grok.accessToken, "acct_resource_limit");
      writeFileSync(
        join(home, ".handwork", "settings.json"),
        JSON.stringify({ provider: "grok", grok_model: "grok-4.20" }) + "\n",
        { mode: 0o600 },
      );
      session = await startHandwork(home, stderrPath, provider, undefined, undefined, {
        HANDWORK_MODEL: undefined,
        HANDWORK_E2E_XAI_GROK_RESPONSES_URL: grok.responsesUrl,
        HANDWORK_E2E_XAI_GROK_MODELS_URL: grok.modelsUrl,
        HANDWORK_E2E_XAI_GROK_MODALITIES_URL: grok.modalitiesUrl,
      });
      await session.waitForComposer(TIMEOUT);
      const failureVisible = session.waitForText("request failed: XaiGrokSseEventTooLarge", TIMEOUT);
      await session.sendText("Recover from a bounded Grok response.");
      await failureVisible;
      await session.sendText("Accept another prompt after recovery.");
      await session.waitForText("GROK_LIMIT_RECOVERED", TIMEOUT);
      await session.sendText("Accept one more prompt after recovery.");
      await session.waitForText("GROK_AFTER_LIMIT_OK", TIMEOUT);

      const scrollback = await session.captureFullScrollback();
      expect(scrollback).toContain("XaiGrokSseEventTooLarge");
      expect(grok.bodies).toHaveLength(3);
      expect(provider.requests).toHaveLength(0);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    } finally {
      grok.stop();
    }
  },
  60_000,
);

for (const scenario of ["replace", "conflict", "invalid-index"] as const) {
  
}

test(
  "Codex rejects the vision fallback without another provider request",
  async () => {
    home = mkdtempSync(join(tmpdir(), "handwork-codex-vision-disabled-"));
    provider = startFakeCodex([]);
    const codex = startFakeCodexToolLoop({
      toolName: "vision",
      toolArguments: { image_ids: [1], focus: "Inspect the image." },
      finalText: "CODEX_VISION_DISABLED_OK",
      inputModalities: ["text", "image"],
    });
    try {
      writeSeededChatGptLogin(home, codex.accessToken);
      writeFileSync(
        join(home, ".handwork", "settings.json"),
        JSON.stringify({ provider: "codex", codex_model: "gpt-5.6-sol" }) + "\n",
        { mode: 0o600 },
      );
      const result = await runHandwork(
        ["ask", "--json", "--auto", "--no-save", "Answer without using a vision fallback."],
        {
          env: {
            HOME: home,
            HANDWORK_AUTH_MODE: "host-managed",

            HANDWORK_DISABLE_KEYCHAIN: "1",
            HANDWORK_AUTO_UPGRADE: "0",
            HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
            HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
            HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: codex.responsesUrl,
            HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: codex.modelsUrl,
          },
          timeoutMs: TIMEOUT,
        },
      );
      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("CODEX_VISION_DISABLED_OK");
      expect(codex.bodies).toHaveLength(2);
      expect(codex.bodies[0]).not.toContain('"name":"vision"');
      const continuation = JSON.parse(codex.bodies[1]) as {
        input: Array<{ type?: string; output?: string }>;
      };
      const toolResult = continuation.input.find(
        (item) => item.type === "function_call_output",
      );
      expect(toolResult?.output).toContain("Vision is unavailable for this request.");
      expect(toolResult?.output).toContain("native image input");
      for (const request of [...provider.requests, ...provider.modelRequests]) {
        expect(request.headers.get("authorization")).not.toBe(`Bearer ${codex.accessToken}`);
      }
    } finally {
      codex.stop();
    }
  },
  60_000,
);

test(
  "Grok rejects the vision fallback because native image input owns OCR",
  async () => {
    home = mkdtempSync(join(tmpdir(), "handwork-grok-vision-disabled-"));
    provider = startFakeCodex([]);
    const grok = startFakeGrokToolLoop({
      toolName: "vision",
      toolArguments: { image_ids: [1], focus: "Inspect the image." },
      finalText: "GROK_VISION_DISABLED_OK",
    });
    try {
      writeSeededGrokLogin(home, grok.accessToken, "acct_vision");
      writeFileSync(
        join(home, ".handwork", "settings.json"),
        JSON.stringify({ provider: "grok", grok_model: "grok-4.20" }) + "\n",
        { mode: 0o600 },
      );
      const result = await runHandwork(
        ["ask", "--json", "--auto", "--no-save", "Answer without a vision fallback."],
        {
          env: {
            HOME: home,
            HANDWORK_AUTH_MODE: "host-managed",

            HANDWORK_DISABLE_KEYCHAIN: "1",
            HANDWORK_AUTO_UPGRADE: "0",
            HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
            HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
            HANDWORK_E2E_XAI_GROK_RESPONSES_URL: grok.responsesUrl,
            HANDWORK_E2E_XAI_GROK_MODELS_URL: grok.modelsUrl,
            HANDWORK_E2E_XAI_GROK_MODALITIES_URL: grok.modalitiesUrl,
          },
          timeoutMs: TIMEOUT,
        },
      );
      expect(result.code, `stdout: ${result.stdout}\nstderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("GROK_VISION_DISABLED_OK");
      expect(grok.bodies).toHaveLength(2);
      expect(grok.bodies[0]).not.toContain('"name":"vision"');
      const continuation = JSON.parse(grok.bodies[1]) as {
        input: Array<{ type?: string; output?: string }>;
      };
      const toolResult = continuation.input.find((item) => item.type === "function_call_output");
      expect(toolResult?.output).toContain("Vision is unavailable for this request.");
      expect(provider.requests).toHaveLength(0);
    } finally {
      grok.stop();
    }
  },
  60_000,
);

for (const outcome of ["failure", "cancel"] as const) {
  
}

for (const scenario of [
  {
    name: "ordinary public empty catalog",
    authenticated: false,
    status: "Using the public model catalog; sign in or use an API key for team-private models.",
  },
  {
    name: "rejected credential empty fallback catalog",
    authenticated: true,
    status: "Your Provider credential was rejected; using the public model catalog.",
  },
]) {
  
}

for (const provider of ["codex", "grok"] as const) {
  test.skipIf(process.platform === "win32")(`${provider} model discovery ignores a FIFO version cache without a writer`, async () => {
    home = mkdtempSync(join(tmpdir(), `handwork-${provider}-version-fifo-`));
    const chatgpt = provider === "codex" ? startFakeChatGptOAuth() : undefined;
    const grok = provider === "grok" ? startFakeGrokOAuth() : undefined;
    const model = provider === "codex" ? "gpt-5.6-luna" : "grok-4.20";
    const version = "1.999.1";
    let releaseRequests = 0;
    const releases = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        releaseRequests++;
        return provider === "codex" ? Response.json({ version }) : new Response(version);
      },
    });
    try {
      if (chatgpt) writeSeededChatGptLogin(home);
      else writeSeededGrokLogin(home, grok!.initialAccessToken);
      writeFileSync(join(home, ".handwork/settings.json"), JSON.stringify({
        provider, models: { [provider]: model },
      }), { mode: 0o600 });
      mkdirSync(join(home, ".handwork/provider-versions"), { mode: 0o700 });
      const cachePath = join(home, ".handwork/provider-versions", `${provider}.json`);
      expect(spawnSync("mkfifo", ["-m", "600", cachePath]).status).toBe(0);
      const env = {
        HOME: home,
        PATH: "/usr/bin:/bin",
        HANDWORK_MODEL: undefined,
        HANDWORK_DISABLE_KEYCHAIN: "1",
        HANDWORK_AUTO_UPGRADE: "0",
        HANDWORK_SOUND: "0",
        ...(chatgpt?.env ?? grok!.env),
        HANDWORK_E2E_CODEX_CLIENT_VERSION: undefined,
        HANDWORK_E2E_GROK_CLIENT_VERSION: undefined,
        [provider === "codex" ? "HANDWORK_E2E_CODEX_VERSION_URL" : "HANDWORK_E2E_GROK_VERSION_URL"]:
          `http://127.0.0.1:${releases.port}/version`,
      };

      const listed = await runHandwork(["models", "--json"], { env, timeoutMs: 8000 });
      expect(listed.timedOut).toBe(false);
      expect(listed.code, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout).models.map((entry: { id: string }) => entry.id)).toContain(model);
      expect(listed.stderr).toBe("");
      expect(releaseRequests).toBe(1);
      expect(statSync(cachePath).isFIFO()).toBe(true);

      const asked = await runHandwork(["ask", "--json", "--auto", "--no-save", "Reply briefly."], { env, timeoutMs: 8000 });
      expect(asked.timedOut).toBe(false);
      expect(asked.code, asked.stderr).toBe(0);
      expect(asked.stdout).toContain(provider === "codex" ? "CHATGPT_DIRECT_RESPONSE" : "GROK_DIRECT_RESPONSE");
      const beforeRepair = releaseRequests;
      expect(beforeRepair).toBeGreaterThan(1);
      unlinkSync(cachePath);
      const repaired = await runHandwork(["models", "--json"], { env, timeoutMs: 8000 });
      expect(repaired.code, repaired.stderr).toBe(0);
      expect(releaseRequests).toBe(beforeRepair + 1);
      expect(JSON.parse(readFileSync(cachePath, "utf8")).version).toBe(version);
      const cached = await runHandwork(["models", "--json"], { env, timeoutMs: 8000 });
      expect(cached.code, cached.stderr).toBe(0);
      expect(cached.stdout).toBe(repaired.stdout);
      expect(releaseRequests).toBe(beforeRepair + 1);
    } finally {
      chatgpt?.stop();
      grok?.stop();
      releases.stop(true);
    }
  }, 30_000);
}

tmuxTest("Codex discovers upstream versions and refreshes models in an open session without a CLI", async () => {
  home = mkdtempSync(join(tmpdir(), "handwork-codex-catalog-version-"));
  stderrPath = join(home, "stderr.log");
  provider = startFakeCodex([]);
  writeSeededChatGptLogin(home);
  writeFileSync(join(home, ".handwork", "settings.json"), JSON.stringify({
    provider: "codex",
    models: { codex: "gpt-5.6-luna" },
  }) + "\n", { mode: 0o600 });
  const versions: Array<string | null> = [];
  const releaseHeaders: Headers[] = [];
  let latest = "0.999.1";
  const catalog = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/version") {
        releaseHeaders.push(request.headers);
        return Response.json({ version: latest });
      }
      const version = new URL(request.url).searchParams.get("client_version");
      versions.push(version);
      const ids = ["gpt-5.6-luna"];
      if (version === latest) ids.push("gpt-6-astra");
      if (version === "1.0.0") ids.push("future-release");
      return Response.json({ models: ids.map((slug) => ({
        slug,
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [{ effort: "high" }, { effort: "ultra" }],
        input_modalities: ["text", "image"],
        context_window: 272000,
      })) });
    },
  });
  try {
    const env = {
      HOME: home,
      PATH: "/usr/bin:/bin",
      HANDWORK_MODEL: undefined,
      HANDWORK_DISABLE_KEYCHAIN: "1",
      HANDWORK_AUTO_UPGRADE: "0",
      HANDWORK_SOUND: "0",
      HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `http://127.0.0.1:${catalog.port}/models`,
      HANDWORK_E2E_CODEX_VERSION_URL: `http://127.0.0.1:${catalog.port}/version`,
      HANDWORK_E2E_CODEX_CLIENT_VERSION: undefined,
    };
    const listed = await runHandwork(["models", "--json"], { env, timeoutMs: TIMEOUT });
    expect(listed.code, listed.stderr).toBe(0);
    const ids = JSON.parse(listed.stdout).models.map((model: { id: string }) => model.id);
    expect(ids).toContain("gpt-6-astra");
    expect(listed.stderr).toBe("");

    session = await startHandwork(home, stderrPath, provider, undefined, undefined, env);
    await session.waitForComposer(TIMEOUT);
    await session.sendText("/model");
    await session.waitForText("gpt-6-astra", TIMEOUT);
    expect(releaseHeaders).toHaveLength(1);
    await session.sendKeys("Escape");
    latest = "1.0.0";
    await Bun.sleep(61_000);
    await session.sendText("/model");
    await session.waitForText("future-release", TIMEOUT);
    expect(releaseHeaders).toHaveLength(2);
    expect(versions.at(-1)).toBe("1.0.0");
    for (const headers of releaseHeaders) {
      for (const name of ["authorization", "cookie", "chatgpt-account-id"]) {
        expect(headers.get(name)).toBeNull();
      }
    }
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(provider.requests).toHaveLength(0);
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  } finally {
    catalog.stop(true);
  }
}, 120_000);

test("Grok refreshes upstream versions for catalogs and responses and survives lookup failures", async () => {
  home = mkdtempSync(join(tmpdir(), "handwork-grok-version-discovery-"));
  const grok = startFakeGrokOAuth();
  let latest = "1.999.1";
  let failure: "none" | "unavailable" | "malformed" | "slow" = "none";
  const releaseHeaders: Headers[] = [];
  const releases = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      releaseHeaders.push(request.headers);
      if (failure === "slow") await Bun.sleep(5000);
      if (failure === "unavailable") return new Response("unavailable", { status: 503 });
      return new Response(failure === "malformed" ? "1.2.3\r\nInjected: bad" : latest);
    },
  });
  try {
    writeSeededGrokLogin(home, grok.initialAccessToken);
    writeFileSync(join(home, ".handwork", "settings.json"), JSON.stringify({
      provider: "grok", models: { grok: "grok-4.20" },
    }) + "\n", { mode: 0o600 });
    const env = {
      HOME: home,
      PATH: "/usr/bin:/bin",
      HANDWORK_DISABLE_KEYCHAIN: "1",
      HANDWORK_AUTO_UPGRADE: "0",
      HANDWORK_SOUND: "0",
      ...grok.env,
      HANDWORK_E2E_GROK_VERSION_URL: `http://127.0.0.1:${releases.port}/stable`,
      HANDWORK_E2E_GROK_CLIENT_VERSION: undefined,
    };
    const cachePath = join(home, ".handwork", "provider-versions", "grok.json");
    const expireCache = () => {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      cached.checked_at_ms = 0;
      writeFileSync(cachePath, JSON.stringify(cached));
    };
    const first = await runHandwork(["models", "--json"], { env });
    expect(first.code, first.stderr).toBe(0);
    expect(releaseHeaders).toHaveLength(1);
    expect(grok.requests.find((request) => request.path === "/v1/models")?.clientVersion).toBe(latest);
    expect(grok.requests.find((request) => request.path === "/v1/language-models")?.clientVersion).toBeNull();

    latest = "2.0.0";
    expireCache();
    const asked = await runHandwork(["ask", "--json", "--auto", "--no-save", "Reply briefly."], { env });
    expect(asked.code, asked.stderr).toBe(0);
    expect(asked.stdout).toContain("GROK_DIRECT_RESPONSE");
    expect(grok.requests.find((request) => request.path === "/v1/responses")?.clientVersion).toBe(latest);
    expect(releaseHeaders).toHaveLength(2);

    for (const mode of ["unavailable", "malformed"] as const) {
      failure = mode;
      expireCache();
      const result = await runHandwork(["models", "--json"], { env });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(cachePath, "utf8")).version).toBe("2.0.0");
    }
    rmSync(cachePath);
    const malformed = await runHandwork(["models", "--json"], { env });
    expect(malformed.code).toBe(1);
    expect(existsSync(cachePath)).toBe(false);
    expect(existsSync(join(home, ".handwork", "grok-auth.json"))).toBe(true);
    failure = "slow";
    const started = Date.now();
    const timedOut = await runHandwork(["models", "--json"], { env, timeoutMs: 8000 });
    expect(timedOut.code).toBe(1);
    expect(Date.now() - started).toBeLessThan(6500);
    for (const headers of releaseHeaders) {
      for (const name of ["authorization", "cookie", "x-userid", "x-xai-token-auth"]) {
        expect(headers.get(name)).toBeNull();
      }
    }
  } finally {
    grok.stop();
    releases.stop(true);
  }
}, 30_000);
tmuxTest("provider preparation does not delay double Ctrl+C shutdown", async () => {
  home = mkdtempSync(join(tmpdir(), "handwork-provider-preparation-exit-"));
  stderrPath = join(home, "stderr.log");
  writeFileSync(stderrPath, "");
  provider = startFakeCodex([]);
  let entered = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  chatgptOauth = startFakeChatGptOAuth({ modelsResponse: async () => { entered = true; await held; } });
  try {
    writeSeededChatGptLogin(home, chatgptOauth.accessToken);
    session = await startHandwork(home, stderrPath, provider, undefined, undefined, { ...chatgptOauth.env, HANDWORK_SOUND: "0" });
    await session.waitForComposer(TIMEOUT);
    await openProviderPicker(session);
    await session.sendLiteral("codex");
    await session.sendKeys("Enter");
    await session.waitForPane(() => entered, 5000);
    await session.sendKeys("C-c");
    await session.sendKeys("C-c");
    await session.waitForSessionEnd(1500);
    session = null;
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  } finally {
    release();
  }
}, TIMEOUT);

for (const outcome of ["cancel", "failure"] as const) {
  
}

tmuxTest("provider preparation cancellation stops logout fallback", async () => {
  home = mkdtempSync(join(tmpdir(), "handwork-logout-preparation-cancel-"));
  stderrPath = join(home, "stderr.log");
  writeFileSync(stderrPath, "");
  let entered = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  provider = startFakeCodex([], { models: async () => {
    entered = true;
    await held;
    return new Response("unavailable", { status: 503 });
  } });
  chatgptOauth = startFakeChatGptOAuth();
  const grok = startFakeGrokOAuth();
  try {
    writeSeededChatGptLogin(home, chatgptOauth.accessToken);
    writeSeededGrokLogin(home, grok.initialAccessToken);
    writeFileSync(join(home, ".handwork", "settings.json"), JSON.stringify({ provider: "codex", models: { codex: "gpt-5.6-sol" } }));
    session = await startHandwork(home, stderrPath, provider, undefined, undefined, { ...chatgptOauth.env, ...grok.env, HANDWORK_MODEL: undefined, HANDWORK_SOUND: "0" });
    await session.waitForComposer(TIMEOUT);
    await session.sendText("/logout");
    await session.waitForPane(() => entered, 5000);
    await session.sendKeys("C-c");
    await session.waitForText("Provider preparation cancelled.", 1500);
    release();
    await Bun.sleep(100);
    expect(grok.requests.filter((request) => request.path === "/v1/models")).toHaveLength(0);
    expect(existsSync(join(home, ".handwork", "chatgpt-auth.json"))).toBe(false);
    expect(existsSync(join(home, ".handwork", "grok-auth.json"))).toBe(true);
    expect(readFileSync(stderrPath, "utf8")).toBe("");
    await session.sendText("/quit");
    await session.waitForSessionEnd(3000);
    session = null;
  } finally { release(); grok.stop(); }
}, TIMEOUT);

tmuxTest("provider recovery continues after a held prompt and failed catalog", async () => {
  home = mkdtempSync(join(tmpdir(), "handwork-provider-fallback-prompt-"));
  stderrPath = join(home, "stderr.log");
  writeFileSync(stderrPath, "");
  let entered = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  provider = startFakeCodex([], { models: async () => {
    entered = true;
    await held;
    return new Response("unavailable", { status: 503 });
  } });
  chatgptOauth = startFakeChatGptOAuth();
  const grok = startFakeGrokOAuth();
  try {
    writeSeededChatGptLogin(home, chatgptOauth.accessToken);
    writeSeededGrokLogin(home, grok.initialAccessToken);
    writeFileSync(join(home, ".handwork", "settings.json"), JSON.stringify({ provider: "codex", models: { codex: "gpt-5.6-sol" } }));
    const trace = join(home, "trace.log");
    session = await startHandwork(home, stderrPath, provider, undefined, trace, { ...chatgptOauth.env, ...grok.env, HANDWORK_MODEL: undefined, HANDWORK_SOUND: "0", HANDWORK_TRACE_SCOPES: "auth,provider,input,prompt" });
    await session.waitForComposer(TIMEOUT);
    await session.sendText("/logout");
    await session.waitForPane(() => entered, 5000);
    await session.sendText("Use the remaining subscription after recovery.");
    await waitForTrace(trace, "pending_prompt_adopted", 3000);
    release();
    await session.waitForText("GROK_DIRECT_RESPONSE", 5000);
    expect(JSON.parse(readFileSync(join(home, ".handwork", "settings.json"), "utf8")).provider).toBe("grok");
    expect(grok.requests.filter((request) => request.path === "/v1/responses")).toHaveLength(1);
    expect(provider.requests).toHaveLength(0);
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  } finally { release(); grok.stop(); }
}, TIMEOUT);


tmuxTest("provider preparation resumes a held prompt after explicit provider retry", async () => {
  home = mkdtempSync(join(tmpdir(), "handwork-preparation-explicit-retry-"));
  stderrPath = join(home, "stderr.log");
  writeFileSync(stderrPath, "");
  let entered = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  provider = startFakeCodex([]);
  chatgptOauth = startFakeChatGptOAuth({ modelsResponse: async () => {
    entered++;
    if (entered === 1) {
      await held;
      return new Response("unavailable", { status: 503 });
    }
  } });
  try {
    writeSeededChatGptLogin(home, chatgptOauth.accessToken);
    const trace = join(home, "trace.log");
    session = await startHandwork(home, stderrPath, provider, undefined, trace, { ...chatgptOauth.env, HANDWORK_MODEL: undefined, HANDWORK_SOUND: "0", HANDWORK_TRACE_SCOPES: "auth,provider,input,prompt" });
    await session.waitForComposer(TIMEOUT);
    await openProviderPicker(session);
    await session.sendLiteral("codex");
    await session.sendKeys("Enter");
    await session.waitForPane(() => entered === 1, 5000);
    await session.sendText("Retain this prompt across the explicit provider retry.");
    await waitForTrace(trace, "pending_prompt_adopted", 3000);
    release();
    await session.waitForText("The target provider catalog could not be validated.", TIMEOUT);
    await openProviderPicker(session);
    await session.sendLiteral("codex");
    await session.sendKeys("Enter");
    await session.waitForText("CHATGPT_DIRECT_RESPONSE", 5000);
    const requests = chatgptOauth.requests.filter((request) => request.path === "/chatgpt/responses");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toContain("Retain this prompt across the explicit provider retry.");
    expect(provider.requests).toHaveLength(0);
    expect(readFileSync(stderrPath, "utf8")).toBe("");
  } finally { release(); }
}, TIMEOUT);
