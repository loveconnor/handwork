import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandwork } from "../evals/eval-helpers";
import {
  LEGACY_REMOTE_TOOL_RESULT,
  LEGACY_SSE_TOOL_RESULT,
  startLegacyHttpSseFixture,
  startLegacyStreamableHttpFixture,
  type LegacyStreamableVersion,
} from "./fixtures/mcp-legacy-remote";
import {
  fakeCodexFinalText,
  fakeCodexToolCall,
  startFakeCodex,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const MODEL = "openai/gpt-5";
const TOOL_NAME = "mcp_fixture_echo";
const REPO_ROOT = realpathSync(join(import.meta.dirname, "..", ".."));
const VERSIONS: LegacyStreamableVersion[] = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];

let cleanupRoot: string | null = null;
let streamable: ReturnType<typeof startLegacyStreamableHttpFixture> | null = null;
let legacySse: ReturnType<typeof startLegacyHttpSseFixture> | null = null;
let provider: ReturnType<typeof startFakeCodex> | null = null;
let tui: TmuxSession | null = null;

afterEach(async () => {
  const activeTui = tui;
  const activeProvider = provider;
  const activeStreamable = streamable;
  const activeLegacySse = legacySse;
  const activeCleanupRoot = cleanupRoot;
  tui = null;
  provider = null;
  streamable = null;
  legacySse = null;
  cleanupRoot = null;

  if (activeTui) await activeTui.kill();
  activeProvider?.stop();
  activeStreamable?.stop();
  activeLegacySse?.stop();
  if (activeCleanupRoot) {
    rmSync(activeCleanupRoot, { recursive: true, force: true });
  }
});

function createRoot(
  label: string,
  transport: "http" | "sse",
  url: string,
  operationTimeoutMs = 5_000,
  remoteOverrides: Record<string, unknown> = {},
) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), `handwork-mcp-legacy-${label}-`)),
  );
  cleanupRoot = root;
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".handwork"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(home, ".handwork", "settings.json"),
    JSON.stringify({}),
  );
  writeFileSync(
    join(home, ".handwork", "mcp.json"),
    JSON.stringify({
      mcp: {
        fixture: {
          type: transport,
          url,
          headers: { "X-Workspace": "legacy" },
          startup_timeout_ms: 5_000,
          operation_timeout_ms: operationTimeoutMs,
          ...remoteOverrides,
        },
      },
    }),
  );
  return { root, home, workspace, traceLogPath: join(root, "handwork-trace.log") };
}

function fixtureEnv(
  root: ReturnType<typeof createRoot>,
  activeProvider: ReturnType<typeof startFakeCodex>,
) {
  return {
    HOME: root.home,
    HANDWORK_AUTH_MODE: "host-managed",

    HANDWORK_AUTO_UPGRADE: "0",
    HANDWORK_PERMISSION_MODE: "auto",
    HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${activeProvider.baseUrl}/models`,
    HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: activeProvider.chatUrl,
    HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: activeProvider.chatUrl,
    HANDWORK_MODEL: MODEL,
    HANDWORK_TRACE_LOG: root.traceLogPath,
    HANDWORK_TRACE_SCOPES: "mcp",
  };
}

function startToolProvider(finalText: string) {
  return startFakeCodex([
    fakeCodexToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
    fakeCodexToolCall("call_mcp", TOOL_NAME, { text: "hello" }),
    fakeCodexFinalText(finalText),
  ], {
    models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
  });
}

async function runAsk(
  root: ReturnType<typeof createRoot>,
  activeProvider: ReturnType<typeof startFakeCodex>,
  prompt: string,
  extraEnv: Record<string, string> = {},
) {
  return runHandwork(
    ["ask", "--json", "--auto", "--no-save", prompt],
    {
      cwd: root.workspace,
      env: {
        ...fixtureEnv(root, activeProvider),
        ...extraEnv,
      },
      timeoutMs: 20_000,
    },
  );
}

function preserveLegacyFailure(
  label: string,
  root: ReturnType<typeof createRoot>,
  result: Awaited<ReturnType<typeof runAsk>>,
  activeFixture: ReturnType<typeof startLegacyHttpSseFixture>,
  activeProvider: ReturnType<typeof startFakeCodex>,
): void {
  cleanupRoot = null;
  writeFileSync(join(root.root, "handwork-stdout.log"), result.stdout);
  writeFileSync(join(root.root, "handwork-stderr.log"), result.stderr);
  writeFileSync(
    join(root.root, "failure.json"),
    JSON.stringify({
      label,
      result,
      fixtureRequests: activeFixture.requests,
      discoveryGets: activeFixture.discoveryGets,
      toolsListCalls: activeFixture.toolsListCalls,
      streamCancelled: activeFixture.streamCancelled,
      providerRequests: activeProvider.requests.map((request) => request.body),
    }, null, 2),
  );
  throw new Error(`handwork ${label} failed; retained artifacts: ${root.root}`);
}

describe("version-scoped legacy MCP remote transports", () => {
  for (const version of VERSIONS) {
    test(`default MCP v1 initializes Streamable HTTP ${version} without probing discovery`, async () => {
      streamable = startLegacyStreamableHttpFixture(version);
      const root = createRoot(`default-v1-${version}`, "http", streamable.url);
      provider = startToolProvider("Default remote MCP v1 complete.");
      const result = await runAsk(root, provider, "Use the MCP tool.");
      expect(result.code).toBe(0);
      expect(streamable.initializeCalls).toBe(1);
      expect(streamable.toolsListCalls).toBe(1);
      expect(streamable.toolCallCalls).toBe(1);
      const requests = streamable.requests.filter((entry) => entry.message?.method);
      expect(requests[0]?.message?.method).toBe("initialize");
      expect(requests.filter((entry) => entry.message?.method === "server/discover")).toHaveLength(0);
    }, 30_000);
  }

  for (const sdkDiscoveryError of [
    "uninitialized",
    "unsupported-version",
    "unsupported-version-string-id",
  ] as const) {
    test(`stock SDK ${sdkDiscoveryError} discovery error falls back to Streamable HTTP initialization`, async () => {
      streamable = startLegacyStreamableHttpFixture("2025-11-25", {
        sdkDiscoveryError,
      });
      const root = createRoot(`sdk-discovery-${sdkDiscoveryError}`, "http", streamable.url);
      const profilePath = join(root.home, ".handwork", "mcp.json");
      const profile = JSON.parse(readFileSync(profilePath, "utf8"));
      profile.mcp.fixture.environment = { HANDWORK_MCP_PROTOCOL_VERSION: "2026-07-28" };
      writeFileSync(profilePath, JSON.stringify(profile));
      provider = startToolProvider("Stock SDK fallback complete.");

      const result = await runAsk(root, provider, "Use the legacy MCP tool.");

      expect(result.code).toBe(0);
      expect(streamable.initializeCalls).toBe(1);
      expect(streamable.toolsListCalls).toBe(1);
      expect(streamable.toolCallCalls).toBe(1);
      const discovery = streamable.requests.find((entry) =>
        entry.message?.method === "server/discover"
      );
      expect(discovery).toBeDefined();
      expect(discovery?.headers["mcp-protocol-version"]).toBe("2026-07-28");
      const initialize = streamable.requests.find((entry) =>
        entry.message?.method === "initialize"
      );
      expect(initialize?.message?.params?.protocolVersion).toBe("2025-11-25");
    }, 30_000);
  }

  test.skipIf(!tmuxAvailable())(
    "legacy list-change health reports an installed listener and lazy feature counts truthfully",
    async () => {
      streamable = startLegacyStreamableHttpFixture("2025-11-25", {
        listChanged: true,
        features: true,
        sdkDiscoveryError: "uninitialized",
      });
      const root = createRoot("legacy-health", "http", streamable.url);
      provider = startFakeCodex([fakeCodexFinalText("unused")], {
        models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
      });
      tui = await TmuxSession.create({
        isolated: true,
        cwd: root.workspace,
        width: 160,
        height: 34,
        env: fixtureEnv(root, provider),
      });

      await tui.waitForComposer(15_000);
      await tui.sendText("/mcp list");
      const pane = await tui.waitForText("MCP health (1 server)", 10_000);
      expect(pane).toContain("protocol=2025-11-25");
      expect(pane).toContain(
        "tools=1 resources=unknown templates=unknown prompts=unknown",
      );
      expect(pane).toContain("subscription=active");
      expect(provider.requests).toHaveLength(0);
    },
    30_000,
  );

  test("legacy Streamable HTTP uses typed feature flows and existing list-change listener", async () => {
    streamable = startLegacyStreamableHttpFixture("2025-06-18", {
      listChanged: true,
      features: true,
    });
    const root = createRoot("features", "http", streamable.url);
    provider = startFakeCodex([
      fakeCodexToolCall("legacy_resource_list_one", "mcp_features", {
        action: "resource_list",
        server: "fixture",
      }),
      async () => {
        await Bun.sleep(200);
        return fakeCodexToolCall("legacy_resource_list_two", "mcp_features", {
          action: "resource_list",
          server: "fixture",
        });
      },
      fakeCodexToolCall("legacy_resource_read", "mcp_features", {
        action: "resource_read",
        server: "fixture",
        uri: "legacy://alpha",
      }),
      fakeCodexToolCall("legacy_prompt_list", "mcp_features", {
        action: "prompt_list",
        server: "fixture",
      }),
      fakeCodexToolCall("legacy_prompt_get", "mcp_features", {
        action: "prompt_get",
        server: "fixture",
        prompt: "review",
        arguments: { tone: "brief" },
      }),
      fakeCodexToolCall("legacy_prompt_complete", "mcp_features", {
        action: "prompt_complete",
        server: "fixture",
        prompt: "review",
        argument: "tone",
        value: "b",
      }),
      fakeCodexFinalText("Legacy MCP features complete."),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });

    const result = await runAsk(root, provider, "Use the legacy MCP features.");

    expect(result.code).toBe(0);
    expect(streamable.resourcesListCalls).toBe(2);
    expect(streamable.requests.some((entry) =>
      entry.message?.method === "subscriptions/listen"
    )).toBe(false);
    const bodies = provider.requests.map((entry) => entry.body).join("\n");
    expect(bodies).toContain("legacy-alpha-fresh");
    expect(bodies).toContain("LEGACY_RESOURCE_TEXT");
    expect(bodies).toContain("LEGACY_PROMPT_TEXT");
    expect(bodies).toContain('\\"trust\\":\\"untrusted_external\\"');
    expect(streamable.requests.filter((entry) =>
      entry.message?.method === "resources/read"
    )).toHaveLength(1);
    expect(streamable.requests.filter((entry) =>
      entry.message?.method === "completion/complete"
    )).toHaveLength(1);
  }, 30_000);

  for (const version of VERSIONS) {
    test(`Streamable HTTP ${version} refreshes Tools from its GET listener without reconnect`, async () => {
      streamable = startLegacyStreamableHttpFixture(version, {
        listChanged: true,
      });
      const root = createRoot(`list-changed-${version}`, "http", streamable.url);
      const freshTool = "mcp_fixture_fresh";
      provider = startFakeCodex([
        fakeCodexToolCall("activate_listener", "capability_search", {
          query: "echo",
        }),
        async () => {
          await Bun.sleep(100);
          return fakeCodexToolCall("search_fresh", "capability_search", {
            query: "fresh",
          });
        },
        fakeCodexToolCall("select_fresh", "mcp_select_tool", {
          name: freshTool,
        }),
        fakeCodexToolCall("call_fresh", freshTool, { text: "changed" }),
        fakeCodexFinalText(`${version} live refresh complete.`),
      ], {
        models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
      });

      const result = await runAsk(root, provider, "Use the changed legacy tool.");

      expect(result.code).toBe(0);
      expect(streamable.currentToolName).toBe("fresh");
      expect(streamable.toolsListCalls).toBe(2);
      expect(streamable.initializeCalls).toBe(1);
      expect(streamable.resumeCalls).toBe(1);
      expect(streamable.requests.some((entry) =>
        entry.message?.method === "subscriptions/listen"
      )).toBe(false);
      const toolCalls = streamable.requests.filter((entry) =>
        entry.message?.method === "tools/call"
      );
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]?.message?.params?.name).toBe("fresh");
      expect(provider.requests.some((entry) => entry.body.includes(freshTool)))
        .toBe(true);
      const listener = streamable.requests.find((entry) =>
        entry.httpMethod === "GET"
      )!;
      expect(listener.headers["mcp-session-id"]).toBe(`session-${version}`);
      expect(listener.headers.accept).toBe("text/event-stream");
      if (version === "2025-03-26") {
        expect(listener.headers["mcp-protocol-version"]).toBeUndefined();
      } else {
        expect(listener.headers["mcp-protocol-version"]).toBe(version);
      }
      const deadline = Date.now() + 5_000;
      while (
        streamable.listenerCancellations === 0 && Date.now() < deadline
      ) {
        await Bun.sleep(25);
      }
      expect(streamable.listenerCancellations).toBe(1);
      expect(streamable.deleteCalls).toBe(1);
    }, 30_000);
  }

  test("deprecated HTTP+SSE routes live Tools changes through its existing reader", async () => {
    legacySse = startLegacyHttpSseFixture({ listChanged: true });
    const root = createRoot("sse-list-changed", "sse", legacySse.url);
    const freshTool = "mcp_fixture_fresh";
    provider = startFakeCodex([
      fakeCodexToolCall("activate_sse_reader", "capability_search", {
        query: "echo",
      }),
      async () => {
        await Bun.sleep(100);
        return fakeCodexToolCall("search_fresh", "capability_search", {
          query: "fresh",
        });
      },
      fakeCodexToolCall("select_fresh", "mcp_select_tool", {
        name: freshTool,
      }),
      fakeCodexToolCall("call_fresh", freshTool, { text: "changed" }),
      fakeCodexFinalText("HTTP+SSE live refresh complete."),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });

    const result = await runAsk(root, provider, "Use the changed SSE tool.");

    expect(result.code).toBe(0);
    expect(legacySse.currentToolName).toBe("fresh");
    expect(legacySse.toolsListCalls).toBe(2);
    expect(legacySse.discoveryGets).toBe(1);
    expect(legacySse.requests.some((entry) =>
      entry.message?.method === "subscriptions/listen"
    )).toBe(false);
    const toolCalls = legacySse.requests.filter((entry) =>
      entry.message?.method === "tools/call"
    );
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.message?.params?.name).toBe("fresh");
    expect(provider.requests.some((entry) => entry.body.includes(freshTool)))
      .toBe(true);
    const deadline = Date.now() + 5_000;
    while (legacySse.streamCancelled === 0 && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(legacySse.streamCancelled).toBe(1);
  }, 30_000);

  for (const version of VERSIONS) {
    test(`fresh handwork ask calls Streamable HTTP ${version} with its lifecycle headers`, async () => {
      streamable = startLegacyStreamableHttpFixture(version);
      const root = createRoot(`ask-${version}`, "http", streamable.url);
      provider = startToolProvider(`${version} complete.`);

      const result = await runAsk(root, provider, `Call the ${version} fixture.`);

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).output).toContain(`${version} complete.`);
      expect(provider.requests[2]?.body).toContain(
        `${LEGACY_REMOTE_TOOL_RESULT}:hello`,
      );
      const messages = streamable.requests
        .filter((entry) => entry.message)
        .map((entry) => entry.message!.method);
      expect(messages).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
      ]);
      const initialize = streamable.requests.find(
        (entry) => entry.message?.method === "initialize",
      )!;
      expect(initialize.headers["mcp-protocol-version"]).toBeUndefined();
      expect(initialize.headers["mcp-session-id"]).toBeUndefined();
      for (
        const entry of streamable.requests.filter((candidate) =>
          candidate.message &&
          candidate.message.method !== "server/discover" &&
          candidate.message.method !== "initialize"
        )
      ) {
        expect(entry.headers["mcp-session-id"]).toBe(`session-${version}`);
        if (version === "2025-03-26") {
          expect(entry.headers["mcp-protocol-version"]).toBeUndefined();
        } else {
          expect(entry.headers["mcp-protocol-version"]).toBe(version);
        }
        expect(entry.headers["x-workspace"]).toBe("legacy");
      }
      expect(streamable.deleteCalls).toBe(1);
    }, 30_000);

    test(`Streamable HTTP ${version} resumes by GET without replaying tools/call`, async () => {
      streamable = startLegacyStreamableHttpFixture(version, { mode: "resume" });
      const root = createRoot(`resume-${version}`, "http", streamable.url);
      provider = startToolProvider(`${version} resumed.`);

      const result = await runAsk(root, provider, `Resume the ${version} fixture.`);

      expect(result.code).toBe(0);
      expect(provider.requests[2]?.body).toContain(
        `${LEGACY_REMOTE_TOOL_RESULT}:resumed`,
      );
      expect(
        streamable.requests.filter(
          (entry) => entry.message?.method === "tools/call",
        ),
      ).toHaveLength(1);
      const resumed = streamable.requests.find(
        (entry) => entry.httpMethod === "GET",
      )!;
      expect(resumed.headers["last-event-id"]).toBe("call-event-1");
      expect(resumed.headers["mcp-session-id"]).toBe(`session-${version}`);
      if (version === "2025-03-26") {
        expect(resumed.headers["mcp-protocol-version"]).toBeUndefined();
      } else {
        expect(resumed.headers["mcp-protocol-version"]).toBe(version);
      }
      expect(streamable.resumeCalls).toBe(1);
    }, 30_000);
  }

  test("Streamable HTTP accepts an omitted session and skips DELETE", async () => {
    streamable = startLegacyStreamableHttpFixture("2025-06-18", {
      session: false,
    });
    const root = createRoot("no-session", "http", streamable.url);
    provider = startToolProvider("No session complete.");

    const result = await runAsk(root, provider, "Call the no-session fixture.");

    expect(result.code).toBe(0);
    expect(streamable.deleteCalls).toBe(0);
    for (const entry of streamable.requests) {
      expect(entry.headers["mcp-session-id"]).toBeUndefined();
    }
  }, 30_000);

  test("Clerk-like SSE initialization without a session remains searchable", async () => {
    streamable = startLegacyStreamableHttpFixture("2025-11-25", {
      initializeSse: true,
      sdkDiscoveryError: "unsupported-version",
      session: false,
    });
    const root = createRoot("clerk-like-sse-no-session", "http", streamable.url);
    provider = startToolProvider("Clerk-like search complete.");

    const result = await runAsk(
      root,
      provider,
      "Find and call the legacy MCP tool.",
    );

    expect(result.code).toBe(0);
    expect(streamable.initializeCalls).toBe(1);
    expect(streamable.toolsListCalls).toBe(1);
    expect(streamable.toolCallCalls).toBe(1);
    expect(streamable.deleteCalls).toBe(0);
    for (const entry of streamable.requests) {
      expect(entry.headers["mcp-session-id"]).toBeUndefined();
    }
  }, 30_000);

  test("legacy Streamable HTTP completes mixed delimiters without waiting for EOF", async () => {
    streamable = startLegacyStreamableHttpFixture("2025-06-18", {
      mode: "mixed_delimiters",
    });
    const root = createRoot("legacy-mixed-delimiters", "http", streamable.url, 1_000);
    provider = startToolProvider("Legacy mixed delimiters complete.");

    const result = await runAsk(root, provider, "Call the mixed delimiter fixture.");

    expect(result.code).toBe(0);
    expect(provider.requests[2]?.body).toContain(
      `${LEGACY_REMOTE_TOOL_RESULT}:hello`,
    );
    const deadline = Date.now() + 5_000;
    while (streamable.cancelledCalls === 0 && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(streamable.cancelledCalls).toBe(1);
  }, 30_000);

  test("legacy Streamable HTTP rejects unsafe resumption IDs before GET", async () => {
    streamable = startLegacyStreamableHttpFixture("2025-06-18", {
      mode: "unsafe_resume_id",
    });
    const root = createRoot("unsafe-resume-id", "http", streamable.url);
    provider = startToolProvider("Unsafe resumption ID rejected.");

    const result = await runAsk(root, provider, "Call the unsafe resumption fixture.");

    expect(result.code).toBe(0);
    expect(streamable.toolCallCalls).toBe(1);
    expect(streamable.resumeCalls).toBe(0);
    expect(provider.requests[2]?.body).toContain("InvalidHeaderValue");
  }, 30_000);

  test("Streamable HTTP releases local session state when DELETE is unsupported", async () => {
    streamable = startLegacyStreamableHttpFixture("2025-06-18", {
      deleteStatus: 405,
    });
    const root = createRoot("delete-unsupported", "http", streamable.url);
    provider = startToolProvider("DELETE unsupported complete.");

    const result = await runAsk(root, provider, "Call the DELETE fixture.");

    expect(result.code).toBe(0);
    expect(streamable.deleteCalls).toBe(1);
  }, 30_000);

  test("Streamable HTTP 2025-11-25 polling resumes after an empty priming event", async () => {
    streamable = startLegacyStreamableHttpFixture("2025-11-25", {
      mode: "poll",
    });
    const root = createRoot("poll", "http", streamable.url);
    provider = startToolProvider("Polling complete.");

    const result = await runAsk(root, provider, "Call the polling fixture.");

    expect(result.code).toBe(0);
    expect(streamable.resumeCalls).toBe(1);
    const resumed = streamable.requests.find(
      (entry) => entry.httpMethod === "GET",
    )!;
    expect(resumed.headers["last-event-id"]).toBe("");
  }, 30_000);

  for (const operation of ["tools", "resources", "prompts"] as const) {
    test.skipIf(!tmuxAvailable())(
      `Streamable HTTP 2025-11-25 ${operation} retries only after the matching URL completion`,
      async () => {
        let targetRequests = 0;
        const target = Bun.serve({
          port: 0,
          fetch() {
            targetRequests += 1;
            return new Response("browser-only target");
          },
        });
        try {
          const targetUrl = `http://127.0.0.1:${target.port}/authorize?state=legacy-http`;
          streamable = startLegacyStreamableHttpFixture("2025-11-25", {
            mode: "url_required_error",
            elicitationUrl: targetUrl,
            urlRequiredOperation: operation,
            features: operation !== "tools",
          });
          const root = createRoot(`url-required-${operation}`, "http", streamable.url);
          const fakeBin = join(root.root, "fake-bin");
          const openLog = join(root.root, "open.log");
          mkdirSync(fakeBin);
          for (const name of ["open", "xdg-open"]) {
            const openPath = join(fakeBin, name);
            writeFileSync(
              openPath,
              "#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$HANDWORK_E2E_OPEN_LOG\"\nexit 0\n",
            );
            chmodSync(openPath, 0o755);
          }
          provider = startFakeCodex([
            ...(operation === "tools"
              ? [
                  fakeCodexToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
                  fakeCodexToolCall("call_mcp", TOOL_NAME, { text: "hello" }),
                ]
              : operation === "resources"
              ? [
                  fakeCodexToolCall("legacy_resource_list", "mcp_features", {
                    action: "resource_list",
                    server: "fixture",
                  }),
                  fakeCodexToolCall("legacy_resource_read", "mcp_features", {
                    action: "resource_read",
                    server: "fixture",
                    uri: "legacy://alpha",
                  }),
                ]
              : [
                  fakeCodexToolCall("legacy_prompt_list", "mcp_features", {
                    action: "prompt_list",
                    server: "fixture",
                  }),
                  fakeCodexToolCall("legacy_prompt_get", "mcp_features", {
                    action: "prompt_get",
                    server: "fixture",
                    prompt: "review",
                    arguments: { tone: "brief" },
                  }),
                ]),
            fakeCodexFinalText(`Legacy HTTP ${operation} URL-required complete.`),
          ], {
            models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
          });
          const binary = join(REPO_ROOT, "zig-out", "bin", "handwork");
          tui = await TmuxSession.create({
            isolated: true,
            cwd: root.workspace,
            width: 110,
            height: 34,
            cmd: `${JSON.stringify(binary)} ask --auto --no-save ${JSON.stringify("Call the legacy HTTP URL-required fixture.")}`,
            remainOnExit: true,
            env: {
              ...fixtureEnv(root, provider),
              PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
              HANDWORK_E2E_OPEN_LOG: openLog,
            },
          });

          await tui.waitForText(`Complete URL: ${targetUrl}`, 20_000);
          await tui.sendText("1");
          await tui.waitForText("I completed it / Retry", 20_000);
          const method = operation === "tools"
            ? "tools/call"
            : operation === "resources"
            ? "resources/read"
            : "prompts/get";
          const operationCalls = () => streamable!.requests.filter(
            (entry) => entry.message?.method === method,
          );
          expect(operationCalls()).toHaveLength(1);
          if (operation === "tools") {
            const malformed = [
              {
                method: "notifications/elicitation/complete",
                params: { elicitationId: "legacy-url-required-1" },
              },
              {
                jsonrpc: "1.0",
                method: "notifications/elicitation/complete",
                params: { elicitationId: "legacy-url-required-1" },
              },
              {
                jsonrpc: 2,
                method: "notifications/elicitation/complete",
                params: { elicitationId: "legacy-url-required-1" },
              },
              {
                jsonrpc: "2.0",
                method: "notifications/elicitation/completed",
                params: { elicitationId: "legacy-url-required-1" },
              },
              {
                jsonrpc: "2.0",
                method: "notifications/elicitation/complete",
                params: [],
              },
              {
                jsonrpc: "2.0",
                method: "notifications/elicitation/complete",
                params: { elicitationId: false },
              },
              {
                jsonrpc: "2.0",
                method: "notifications/elicitation/complete",
                params: { elicitationId: "" },
              },
              {
                jsonrpc: "2.0",
                method: "notifications/elicitation/complete",
                params: { elicitationId: "x".repeat(257) },
              },
            ];
            for (const notification of malformed) {
              streamable.sendUrlCompletionFrame(notification);
            }
          }
          streamable.sendUrlCompletion("wrong-url-id");
          await Bun.sleep(100);
          expect(operationCalls()).toHaveLength(1);
          streamable.sendUrlCompletion("legacy-url-required-1");
          streamable.sendUrlCompletion("legacy-url-required-1");
          await tui.waitForText(`Legacy HTTP ${operation} URL-required complete.`, 20_000);
          expect(readFileSync(openLog, "utf8").trim()).toBe(targetUrl);
          expect(targetRequests).toBe(0);
          const calls = streamable.requests.filter(
            (entry) => entry.message?.method === method,
          );
          expect(calls).toHaveLength(2);
          expect(calls[1]?.message?.id).not.toBe(calls[0]?.message?.id);
          expect(calls[1]?.message?.params?.inputResponses).toBeUndefined();
          expect(calls[1]?.message?.params?.requestState).toBeUndefined();
        } finally {
          target.stop(true);
        }
      },
      30_000,
    );
  }

  test("Streamable HTTP 2025-06-18 does not interpret the 2025-11 URL-required error", async () => {
    streamable = startLegacyStreamableHttpFixture("2025-06-18", {
      mode: "url_required_error",
      elicitationUrl: "https://example.test/unsupported-version",
    });
    const root = createRoot("url-required-version-gate", "http", streamable.url);
    provider = startToolProvider("Legacy HTTP URL-required version gate complete.");

    const result = await runAsk(root, provider, "Call the version-gated legacy fixture.");

    expect(result.code).toBe(0);
    expect(streamable.toolCallCalls).toBe(1);
    expect(provider.requests[2]?.body).toContain("MCP protocol error -32042");
  }, 30_000);

  test("Streamable HTTP completes a final POST event without waiting for stream EOF", async () => {
    streamable = startLegacyStreamableHttpFixture("2025-06-18", {
      mode: "hold_open_call",
    });
    const root = createRoot("held-open-post", "http", streamable.url, 1_000);
    provider = startToolProvider("Held-open POST complete.");

    const result = await runAsk(root, provider, "Call the held-open fixture.");

    expect(result.code).toBe(0);
    expect(provider.requests[2]?.body).toContain(
      `${LEGACY_REMOTE_TOOL_RESULT}:hello`,
    );
    expect(streamable.toolCallCalls).toBe(1);
    const deadline = Date.now() + 5_000;
    while (streamable.cancelledCalls === 0 && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(streamable.cancelledCalls).toBe(1);
  }, 30_000);

  test("Streamable HTTP reinitializes an expired session without replaying the failed call", async () => {
    const version = "2025-06-18";
    streamable = startLegacyStreamableHttpFixture(version, {
      mode: "expire_session",
    });
    const root = createRoot(
      "expired-session",
      "http",
      streamable.url,
      5_000,
      {
        headers: {},
        header_env: { "X-Workspace": "MCP_LEGACY_WORKSPACE" },
        bearer_token_env: "MCP_LEGACY_BEARER",
      },
    );
    provider = startFakeCodex([
      fakeCodexToolCall("select_mcp", "mcp_select_tool", { name: TOOL_NAME }),
      fakeCodexToolCall("expired_call", TOOL_NAME, { text: "expired" }),
      fakeCodexToolCall("recovered_call", TOOL_NAME, { text: "recovered" }),
      fakeCodexFinalText("Session recovery complete."),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });

    const result = await runAsk(
      root,
      provider,
      "Recover the expired session.",
      {
        MCP_LEGACY_WORKSPACE: "legacy-recovery-environment",
        MCP_LEGACY_BEARER: "legacy-recovery-secret",
      },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).output).toContain(
      "Session recovery complete.",
    );
    expect(provider.requests[2]?.body).toContain("tool_execution_failed");
    expect(provider.requests[3]?.body).toContain(
      `${LEGACY_REMOTE_TOOL_RESULT}:recovered`,
    );
    expect(streamable.initializeCalls).toBe(2);
    expect(streamable.toolCallCalls).toBe(2);
    const calls = streamable.requests.filter(
      (entry) => entry.message?.method === "tools/call",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers["mcp-session-id"]).toBe(
      `session-${version}-1`,
    );
    expect(calls[1]?.headers["mcp-session-id"]).toBe(
      `session-${version}-2`,
    );
    const reinitialize = streamable.requests.filter(
      (entry) => entry.message?.method === "initialize",
    )[1]!;
    expect(reinitialize.headers["mcp-session-id"]).toBeUndefined();
    for (const request of streamable.requests) {
      expect(request.headers["x-workspace"]).toBe(
        "legacy-recovery-environment",
      );
      expect(request.headers.authorization).toBe(
        "Bearer legacy-recovery-secret",
      );
    }
    expect(result.stdout).not.toContain("legacy-recovery-secret");
    expect(result.stderr).not.toContain("legacy-recovery-secret");
    expect(streamable.deleteCalls).toBe(1);
  }, 30_000);

  test("legacy Streamable HTTP keeps tools rejected by modern header projection", async () => {
    streamable = startLegacyStreamableHttpFixture("2025-06-18", {
      invalidModernHeaderSchema: true,
    });
    const root = createRoot("legacy-schema-isolation", "http", streamable.url);
    provider = startToolProvider("Legacy schema isolation complete.");

    const result = await runAsk(
      root,
      provider,
      "Call the legacy schema isolation fixture.",
    );

    expect(result.code).toBe(0);
    expect(provider.requests[2]?.body).toContain(
      `${LEGACY_REMOTE_TOOL_RESULT}:hello`,
    );
    expect(streamable.toolCallCalls).toBe(1);
  }, 30_000);

  test("legacy Streamable HTTP captures scope challenges without replaying a tool call", async () => {
    streamable = startLegacyStreamableHttpFixture("2025-06-18", {
      rejectToolAuth: true,
    });
    const root = createRoot(
      "legacy-auth-rejection",
      "http",
      streamable.url,
      5_000,
      { oauth: { resource: streamable.url } },
    );
    provider = startToolProvider("Legacy authentication required.");

    const result = await runAsk(
      root,
      provider,
      "Call the protected legacy fixture.",
    );

    expect(result.code).toBe(0);
    expect(streamable.toolCallCalls).toBe(1);
    expect(provider.requests[2]?.body).toContain("tool_execution_failed");
    expect(provider.requests[2]?.body).toContain("McpAuthenticationRequired");
  }, 30_000);

  test("fresh handwork ask uses explicit HTTP+SSE endpoint discovery and message routing", async () => {
    legacySse = startLegacyHttpSseFixture();
    const root = createRoot(
      "sse-ask",
      "sse",
      legacySse.url,
      5_000,
      {
        headers: {},
        header_env: { "X-Workspace": "MCP_SSE_WORKSPACE" },
        bearer_token_env: "MCP_SSE_BEARER",
      },
    );
    provider = startToolProvider("HTTP+SSE complete.");

    const result = await runAsk(
      root,
      provider,
      "Call the explicit SSE fixture.",
      {
        MCP_SSE_WORKSPACE: "sse-environment",
        MCP_SSE_BEARER: "sse-bearer-secret",
      },
    );

    expect(result.code).toBe(0);
    expect(provider.requests[2]?.body).toContain(
      `${LEGACY_SSE_TOOL_RESULT}:hello`,
    );
    expect(legacySse.discoveryGets).toBe(1);
    expect(
      legacySse.requests.filter((entry) => entry.httpMethod === "POST")
        .map((entry) => entry.path),
    ).toEqual(["/messages", "/messages", "/messages", "/messages"]);
    expect(
      legacySse.requests.filter((entry) => entry.message)
        .map((entry) => entry.message!.method),
    ).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    for (const request of legacySse.requests) {
      expect(request.headers["x-workspace"]).toBe("sse-environment");
      expect(request.headers.authorization).toBe("Bearer sse-bearer-secret");
    }
    expect(result.stdout).not.toContain("sse-bearer-secret");
    expect(result.stderr).not.toContain("sse-bearer-secret");
    const deadline = Date.now() + 5_000;
    while (legacySse.streamCancelled === 0 && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(legacySse.streamCancelled).toBe(1);
  }, 30_000);

  test("HTTP+SSE captures scope challenges without replaying a tool call", async () => {
    legacySse = startLegacyHttpSseFixture({ rejectToolAuth: true });
    const root = createRoot(
      "sse-auth-rejection",
      "sse",
      legacySse.url,
      5_000,
      { oauth: { resource: legacySse.url } },
    );
    provider = startToolProvider("HTTP+SSE authentication required.");

    const result = await runAsk(
      root,
      provider,
      "Call the protected explicit SSE fixture.",
    );

    expect(result.code).toBe(0);
    expect(
      legacySse.requests.filter(
        (request) => request.message?.method === "tools/call",
      ),
    ).toHaveLength(1);
    expect(provider.requests[2]?.body).toContain("tool_execution_failed");
    expect(provider.requests[2]?.body).toContain("McpAuthenticationRequired");
  }, 30_000);

  test("HTTP+SSE routes bare-CR events without waiting for LF", async () => {
    legacySse = startLegacyHttpSseFixture({ bareCr: true });
    const root = createRoot("sse-bare-cr", "sse", legacySse.url, 1_000);
    provider = startToolProvider("HTTP+SSE bare CR complete.");

    const result = await runAsk(root, provider, "Call the bare-CR SSE fixture.");

    if (
      result.code !== 0 ||
      !provider.requests[2]?.body.includes(`${LEGACY_SSE_TOOL_RESULT}:hello`)
    ) {
      preserveLegacyFailure("legacy-sse-bare-cr", root, result, legacySse, provider);
    }

    expect(result.code).toBe(0);
    expect(provider.requests[2]?.body).toContain(
      `${LEGACY_SSE_TOOL_RESULT}:hello`,
    );
    expect(legacySse.discoveryGets).toBe(1);
    const deadline = Date.now() + 5_000;
    while (legacySse.streamCancelled === 0 && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(legacySse.streamCancelled).toBe(1);
  }, 30_000);

  for (const selectedVersion of [null, "2025-03-26"] as const) {
    const label = selectedVersion ?? "missing";
    test(`HTTP+SSE rejects ${label} initialize version and closes discovery`, async () => {
      legacySse = startLegacyHttpSseFixture({
        protocolVersion: selectedVersion,
      });
      const root = createRoot(`sse-version-${label}`, "sse", legacySse.url);
      provider = startFakeCodex([
        fakeCodexToolCall("inspect_invalid_sse", "capability_search", {
          query: "echo",
        }),
        fakeCodexFinalText("Invalid SSE version isolated."),
      ], {
        models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
      });

      const result = await runAsk(
        root,
        provider,
        "Do not use the invalid SSE fixture.",
      );

      expect(result.code).toBe(0);
      expect(provider.requests.every((request) => !request.body.includes(TOOL_NAME)))
        .toBe(true);
      expect(
        legacySse.requests.filter((entry) => entry.message)
          .map((entry) => entry.message!.method),
      ).toEqual(["initialize"]);
      const deadline = Date.now() + 5_000;
      while (legacySse.streamCancelled === 0 && Date.now() < deadline) {
        await Bun.sleep(25);
      }
      expect(legacySse.streamCancelled).toBe(1);
    }, 30_000);
  }

  test("HTTP+SSE cleans up when discovery is followed by a malformed message", async () => {
    legacySse = startLegacyHttpSseFixture({ malformedAfterEndpoint: true });
    const root = createRoot(
      "sse-malformed-after-endpoint",
      "sse",
      legacySse.url,
    );
    provider = startFakeCodex([
      fakeCodexToolCall("inspect_malformed_sse", "capability_search", {
        query: "echo",
      }),
      fakeCodexFinalText("Malformed SSE startup isolated."),
    ], {
      models: [{ id: MODEL, type: "language", tags: ["tool-use"] }],
    });

    const result = await runAsk(
      root,
      provider,
      "Do not use the malformed SSE fixture.",
    );

    expect(result.code).toBe(0);
    expect(provider.requests.every((request) => !request.body.includes(TOOL_NAME)))
      .toBe(true);
    const deadline = Date.now() + 5_000;
    while (legacySse.streamCancelled === 0 && Date.now() < deadline) {
      await Bun.sleep(25);
    }
    expect(legacySse.streamCancelled).toBe(1);
  }, 30_000);

  for (const version of VERSIONS) {
    test.skipIf(!tmuxAvailable())(
      `TUI cancellation sends ${version} cancellation headers and cleans up`,
      async () => {
        streamable = startLegacyStreamableHttpFixture(version, {
          mode: "stall_call",
        });
        const root = createRoot(
          `cancel-http-${version}`,
          "http",
          streamable.url,
          30_000,
        );
        provider = startToolProvider("Cancelled legacy HTTP complete.");
        tui = await TmuxSession.create({
          isolated: true,
          cwd: root.workspace,
          width: 100,
          height: 30,
          env: fixtureEnv(root, provider),
        });

        await tui.waitForComposer(15_000);
        await tui.sendText("Call the stalled legacy HTTP fixture.");
        const callDeadline = Date.now() + 15_000;
        while (
          !streamable.requests.some(
            (entry) => entry.message?.method === "tools/call",
          ) &&
          Date.now() < callDeadline
        ) {
          await Bun.sleep(25);
        }
        expect(
          streamable.requests.some(
            (entry) => entry.message?.method === "tools/call",
          ),
        ).toBe(true);

        await tui.sendInterruptEscapePair(10_000);
        await tui.waitForText(`Cancelled ${TOOL_NAME}`, 10_000);
        const cancelDeadline = Date.now() + 5_000;
        while (
          (streamable.cancellationNotifications === 0 ||
            streamable.cancelledCalls === 0) &&
          Date.now() < cancelDeadline
        ) {
          await Bun.sleep(25);
        }
        const cancellation = streamable.requests.find(
          (entry) => entry.message?.method === "notifications/cancelled",
        )!;
        expect(cancellation.headers["mcp-session-id"]).toBe(
          `session-${version}`,
        );
        if (version === "2025-03-26") {
          expect(cancellation.headers["mcp-protocol-version"]).toBeUndefined();
        } else {
          expect(cancellation.headers["mcp-protocol-version"]).toBe(version);
        }
        expect(streamable.cancellationNotifications).toBe(1);
        expect(streamable.cancelledCalls).toBe(1);

        await tui.waitForComposer(10_000);
        await tui.sendText("/quit");
        await tui.waitForSessionEnd(10_000);
        tui = null;
        expect(streamable.deleteCalls).toBe(1);
      },
      40_000,
    );
  }

  test.skipIf(!tmuxAvailable())(
    "TUI cancellation routes HTTP+SSE cancellation to the discovered message endpoint",
    async () => {
      legacySse = startLegacyHttpSseFixture({ stallCall: true });
      const root = createRoot("cancel-sse", "sse", legacySse.url, 30_000);
      provider = startToolProvider("Cancelled HTTP+SSE complete.");
      tui = await TmuxSession.create({
        isolated: true,
        cwd: root.workspace,
        width: 100,
        height: 30,
        env: fixtureEnv(root, provider),
      });

      await tui.waitForComposer(15_000);
      await tui.sendText("Call the stalled explicit SSE fixture.");
      const callDeadline = Date.now() + 15_000;
      while (
        !legacySse.requests.some(
          (entry) => entry.message?.method === "tools/call",
        ) &&
        Date.now() < callDeadline
      ) {
        await Bun.sleep(25);
      }
      await tui.sendInterruptEscapePair(10_000);
      await tui.waitForText(`Cancelled ${TOOL_NAME}`, 10_000);
      const cancelDeadline = Date.now() + 5_000;
      while (
        legacySse.cancellationNotifications === 0 &&
        Date.now() < cancelDeadline
      ) {
        await Bun.sleep(25);
      }
      expect(legacySse.cancellationNotifications).toBe(1);
      expect(
        legacySse.requests.find(
          (entry) => entry.message?.method === "notifications/cancelled",
        )?.path,
      ).toBe("/messages");
    },
    40_000,
  );
});
