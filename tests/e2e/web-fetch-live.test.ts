import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandwork } from "../evals/eval-helpers";

const TIMEOUT = 60_000;
const OUTER_MODEL = "anthropic/claude-sonnet-4.6";
const LIVE_URL = "https://example.com/";
const LIVE_ROBOTS_URL = "https://auth.handwork.invalid/robots.txt";
const LIVE_MODELS_URL = "https://provider.handwork.invalid/models";
const LIVE_BINARY_URL =
  "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf";

type ProviderRequest = {
  body: string;
  headers: Headers;
};

function sse(events: object[], done = true) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      (done ? "data: [DONE]\n\n" : ""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function outerWebFetchCall(url = LIVE_URL) {
  return sse([
    { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "fetch_live_1", name: "web_fetch", arguments: JSON.stringify({
        url,
      }) } },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: ({}).inputTokens?.total ?? 0, output_tokens: ({}).outputTokens?.total ?? 0 } } },
  ]);
}

function outerText(text: string) {
  return sse([
    { type: "response.output_text.delta", delta: text },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: ({
        inputTokens: { total: 11 },
        outputTokens: { total: 13 },
      }).inputTokens?.total ?? 0, output_tokens: ({
        inputTokens: { total: 11 },
        outputTokens: { total: 13 },
      }).outputTokens?.total ?? 0 } } },
  ]);
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve loopback port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function startFakeCodex(responses: Response[]) {
  const requests: ProviderRequest[] = [];
  const port = await reserveLoopbackPort();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/models") {
        return Response.json({ models: [{ id: OUTER_MODEL, type: "language", tags: ["tool-use"] }].filter(model => model.type === "language").map(model => ({ slug: model.id, visibility: "list", supported_in_api: true, context_window: 272000, supported_reasoning_levels: [], input_modalities: ["text"] })) });
      }
      if (req.method !== "POST") return new Response("not found", { status: 404 });
      requests.push({ body: await req.text(), headers: req.headers });
      return responses.shift() ?? new Response("unexpected request", { status: 500 });
    },
  });

  return {
    chatUrl: `http://127.0.0.1:${server.port}/responses`,
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    stop() {
      server.stop(true);
    },
  };
}

function createIsolatedRoot(domains = ["example.com"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "handwork-web-fetch-live-")));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".handwork"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(home, ".handwork", "settings.json"),
    JSON.stringify({
      model: OUTER_MODEL,
      permission: {
        web_fetch: Object.fromEntries(domains.map((domain) => [`domain:${domain}`, "allow"])),
      },
    }),
  );
  return { root, home, workspace: realpathSync(workspace) };
}

function fakeCodexEnv(
  root: ReturnType<typeof createIsolatedRoot>,
  provider: Awaited<ReturnType<typeof startFakeCodex>>,
) {
  return {
    HOME: root.home,
    HANDWORK_AUTH_MODE: "host-managed",

    HANDWORK_AUTO_UPGRADE: "0",
    HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
    HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
    HANDWORK_MODEL: OUTER_MODEL,
  };
}

describe.skipIf(process.env.HANDWORK_WEB_FETCH_LIVE !== "1")("live web_fetch public URL", () => {
  // These mutable endpoints are operational probes, not deterministic HTTP
  // framing proof. The transport/framing contract is covered by Zig fixtures.
  for (const probe of [
    { url: LIVE_ROBOTS_URL, domain: "auth.handwork.invalid", label: "robots" },
    { url: LIVE_MODELS_URL, domain: "provider.handwork.invalid", label: "models" },
  ] as const) {
    test(
      `${probe.label} endpoint returns non-empty content through the fresh binary`,
      async () => {
        const root = createIsolatedRoot([probe.domain]);
        const traceLog = join(root.root, `${probe.label}-trace.log`);
        const provider = await startFakeCodex([
          outerWebFetchCall(probe.url),
          outerText(`Final: ${probe.label} endpoint fetched successfully.`),
        ]);
        try {
          const result = await runHandwork(
            ["ask", "--auto", "--json", "--no-save", `Fetch ${probe.url} exactly once.`],
            {
              cwd: root.workspace,
              env: {
                ...fakeCodexEnv(root, provider),
                HANDWORK_TRACE_LOG: traceLog,
                HANDWORK_TRACE_SCOPES: "tool",
              },
              timeoutMs: TIMEOUT,
            },
          );

          if (result.code !== 0) {
            throw new Error(
              `handwork exited ${result.code}\nstdout: ${result.stdout.slice(-4000)}\nstderr: ${result.stderr.slice(-4000)}`,
            );
          }
          const json = JSON.parse(result.stdout.trim()) as {
            output: string;
            tool_calls: Array<{
              name: string;
              status: string;
              web_fetch?: {
                url: string;
                bytes: number;
                status: number;
              };
            }>;
          };
          const fetches = json.tool_calls.filter((call) => call.name === "web_fetch");
          expect(fetches).toHaveLength(1);
          if (fetches[0].status !== "success") {
            const trace = existsSync(traceLog) ? readFileSync(traceLog, "utf8") : "";
            throw new Error(
              `web_fetch probe failed\nstdout: ${result.stdout.slice(-4000)}\nstderr: ${result.stderr.slice(-4000)}\ntrace: ${trace.slice(-8000)}`,
            );
          }
          expect(fetches[0].status).toBe("success");
          expect(fetches[0].web_fetch?.url).toBe(probe.url);
          expect(fetches[0].web_fetch?.status).toBe(200);
          expect(fetches[0].web_fetch?.bytes).toBeGreaterThan(0);
          expect(json.tool_calls.every((call) => call.name === "web_fetch")).toBe(true);
          expect(result.stderr).toContain("Fetching ");
          expect(result.stderr).toContain("Converting ");
          expect(result.stderr).not.toContain("Extracting ");
          expect(result.stderr).not.toContain("panic");
          expect(result.stderr).not.toContain("abort");
          expect(result.stderr).not.toContain("python");
          expect(result.stderr).not.toContain("curl");
          expect(provider.requests).toHaveLength(2);
          expect(json.output).toContain(`${probe.label} endpoint`);

          console.log(
            `[live-web-fetch-probe] label=${probe.label} url=${fetches[0].web_fetch!.url} bytes=${fetches[0].web_fetch!.bytes}`,
          );
        } finally {
          provider.stop();
          rmSync(root.root, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }

  test(
    "authorized public HTML URL reports progress and cache metadata",
    async () => {
      const root = createIsolatedRoot();
      const provider = await startFakeCodex([
        outerWebFetchCall(),
        outerWebFetchCall(),
        outerText("Final: Example Domain was fetched and cached."),
      ]);
      try {
        const result = await runHandwork(
          ["ask", "--auto", "--json", "--no-save", "Fetch and then refetch https://example.com/."],
          {
            cwd: root.workspace,
            env: fakeCodexEnv(root, provider),
            timeoutMs: TIMEOUT,
          },
        );

        if (result.code !== 0) {
          throw new Error(
            `handwork exited ${result.code}\nstdout: ${result.stdout.slice(-4000)}\nstderr: ${result.stderr.slice(-4000)}`,
          );
        }
        const json = JSON.parse(result.stdout.trim()) as {
          output: string;
          tool_calls: Array<{
            name: string;
            status: string;
            web_fetch?: {
              url: string;
              bytes: number;
              status: number;
              duration_ms: number;
              cache_hit: boolean;
              artifact: string;
            };
          }>;
        };
        const fetches = json.tool_calls.filter((call) => call.name === "web_fetch");
        expect(fetches).toHaveLength(2);
        expect(fetches[0].status).toBe("success");
        expect(fetches[0].web_fetch?.url).toBe(LIVE_URL);
        expect(fetches[0].web_fetch?.status).toBe(200);
        expect(fetches[0].web_fetch?.bytes).toBeGreaterThan(0);
        expect(fetches[0].web_fetch?.cache_hit).toBe(false);
        expect(fetches[1].status).toBe("success");
        expect(fetches[1].web_fetch?.cache_hit).toBe(true);
        expect(fetches[1].web_fetch?.artifact).toBe("none");
        expect(result.stderr).toContain("Fetching ");
        expect(result.stderr).toContain("Converting ");
        expect(result.stderr).not.toContain("Extracting ");
        expect(provider.requests).toHaveLength(3);
        expect(provider.requests[2].body).toContain("<cache_hit>true</cache_hit>");
        expect(json.output).toContain("Example Domain");

        console.log(
          `[live-web-fetch] url=${fetches[0].web_fetch!.url} bytes=${fetches[0].web_fetch!.bytes} first_cache_hit=${fetches[0].web_fetch!.cache_hit} second_cache_hit=${fetches[1].web_fetch!.cache_hit}`,
        );
      } finally {
        provider.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "authorized public binary URL stores a durable artifact without raw bytes in session JSON",
    async () => {
      const root = createIsolatedRoot(["www.w3.org"]);
      const provider = await startFakeCodex([
        outerWebFetchCall(LIVE_BINARY_URL),
        outerText("Final: PDF artifact metadata was recorded."),
      ]);
      try {
        const result = await runHandwork(
          ["ask", "--auto", "--json", "Fetch the public PDF artifact."],
          {
            cwd: root.workspace,
            env: fakeCodexEnv(root, provider),
            timeoutMs: TIMEOUT,
          },
        );

        if (result.code !== 0) {
          throw new Error(
            `handwork exited ${result.code}\nstdout: ${result.stdout.slice(-4000)}\nstderr: ${result.stderr.slice(-4000)}`,
          );
        }
        const json = JSON.parse(result.stdout.trim()) as {
          session_id: string;
          tool_calls: Array<{
            name: string;
            status: string;
            web_fetch?: {
              url: string;
              bytes: number;
              status: number;
              duration_ms: number;
              cache_hit: boolean;
              artifact: string;
            };
          }>;
        };
        const fetch = json.tool_calls.find((call) => call.name === "web_fetch");
        expect(fetch?.status).toBe("success");
        expect(fetch?.web_fetch?.url).toBe(LIVE_BINARY_URL);
        expect(fetch?.web_fetch?.status).toBe(200);
        expect(fetch?.web_fetch?.bytes).toBeGreaterThan(0);
        expect(fetch?.web_fetch?.cache_hit).toBe(false);
        expect(fetch?.web_fetch?.artifact).toBe("stored");

        const sessionDir = join(root.home, ".handwork", "sessions", json.session_id);
        const artifactDir = join(sessionDir, "artifacts", "web-fetch");
        expect(existsSync(artifactDir)).toBe(true);
        const files = readdirSync(artifactDir).filter((name) => name.startsWith("artifact-"));
        expect(files).toHaveLength(1);
        const artifactPath = join(artifactDir, files[0]!);
        const artifactBytes = readFileSync(artifactPath);
        expect(artifactBytes.length).toBe(fetch!.web_fetch!.bytes);
        expect(artifactBytes.subarray(0, 5).toString()).toBe("%PDF-");

        const artifactBase64Prefix = artifactBytes.toString("base64").slice(0, 16);
        const sessionJson = readFileSync(join(sessionDir, "session.json"), "utf8");
        expect(sessionJson).not.toContain("%PDF-");
        expect(sessionJson).not.toContain(artifactBase64Prefix);
        expect(sessionJson).not.toContain("Store the file and summarize safe metadata only.");
        const sessionEvents = readFileSync(join(sessionDir, "events.jsonl"), "utf8");
        expect(sessionEvents).not.toContain("%PDF-");
        expect(sessionEvents).not.toContain(artifactBase64Prefix);
        expect(sessionEvents).not.toContain("Store the file and summarize safe metadata only.");
        const detail = await runHandwork(["session", "--id", json.session_id, "--json"], {
          cwd: root.workspace,
          env: fakeCodexEnv(root, provider),
          timeoutMs: TIMEOUT,
        });
        expect(detail.code).toBe(0);
        expect(detail.stderr).toBe("");
        expect(detail.stdout).toContain(files[0]!);
        expect(detail.stdout).toContain("<artifact_handle>");
        expect(detail.stdout).not.toContain("%PDF-");
        expect(detail.stdout).not.toContain(artifactBase64Prefix);
        expect(detail.stdout).not.toContain("Store the file and summarize safe metadata only.");
        expect(result.stderr).toContain("Fetching ");
        expect(result.stderr).toContain("Converting ");
        expect(result.stderr).not.toContain("Extracting ");
        expect(provider.requests).toHaveLength(2);

        console.log(
          `[live-web-fetch-binary] url=${fetch!.web_fetch!.url} bytes=${fetch!.web_fetch!.bytes} artifact=${files[0]}`,
        );
      } finally {
        provider.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
