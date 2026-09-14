import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  cleanupIsolatedTestHome,
  createIsolatedTestHome,
  HANDWORK_BIN,
  HAS_SUBSCRIPTION,
  REPO_ROOT,
  runHandwork,
} from "../evals/eval-helpers";
import {
  FAKE_CODEX_MODEL,
  fakeCodexFinalText,
  fakeCodexSse,
  startFakeCodex,
} from "./tmux-helpers";

const TIMEOUT = 15_000;
const NO_PROVIDER_AUTH = {


};
const MISSING_AUTH_MESSAGE =
  "handwork needs a Codex subscription login for this model. Run handwork login codex.";
const MODERN_MCP_FIXTURE = join(
  import.meta.dirname,
  "fixtures",
  "mcp-modern-stdio.mjs",
);

function maxLineWidth(text: string): number {
  return Math.max(...text.split(/\r?\n/).map((line) => Bun.stringWidth(line)));
}

function sourceVersion(): string {
  const source = readFileSync(join(REPO_ROOT, "src/main.zig"), "utf8");
  const match = source.match(/pub const version = "([^"]+)";/);
  if (!match) throw new Error("src/main.zig version declaration not found");
  return match[1];
}

function doctorSessionDiagnosticsLimit(): number {
  const source = readFileSync(
    join(REPO_ROOT, "src/core/cli/doctor_runtime.zig"),
    "utf8",
  );
  const match = source.match(/const default_session_diagnostics_limit: usize = (\d+);/);
  if (!match) throw new Error("doctor session diagnostics limit not found");
  return Number(match[1]);
}

const SEEDED_PROVIDER_TOKEN = "seeded-access-token";

function writeSeededHandworkAuth(
  home: string,
  teamId?: string,
  issuer = "https://auth.handwork.invalid",
  expiresAtMs = Date.now() + 60 * 60 * 1000,
): void {
  const handworkDir = join(home, ".handwork");
  mkdirSync(handworkDir, { recursive: true, mode: 0o700 });
  chmodSync(handworkDir, 0o700);
  const authPath = join(handworkDir, "auth.json");
  const auth: Record<string, string | number> = {
    version: 1,
    issuer,
    client_id: "test-client",
    access_token: SEEDED_PROVIDER_TOKEN,
    refresh_token: "seeded-refresh-token",
    expires_at_ms: expiresAtMs,
    scope: "openid",
    token_type: "Bearer",
  };
  if (teamId) {
    auth.team_id = teamId;
    auth.team_slug = "loveconnor";
  }
  writeFileSync(authPath, JSON.stringify(auth) + "\n", { mode: 0o600 });
  chmodSync(authPath, 0o600);
}

function startRequestCatcher() {
  const requests: Array<{ method: string; path: string }> = [];
  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      return Response.json({ revoked: true });
    },
  });
  return {
    issuerUrl: `http://127.0.0.1:${server.port}`,
    endpoint: `http://localhost.:${server.port}/oauth/revoke`,
    requests,
    stop() {
      server.stop(true);
    },
  };
}

function snapshotTree(root: string): string[] {
  const entries: string[] = [];
  const visit = (path: string, relative: string): void => {
    const info = lstatSync(path);
    entries.push(
      `${relative}|${info.isDirectory() ? "dir" : "file"}|${info.mode & 0o777}|${info.size}`,
    );
    if (!info.isDirectory()) return;
    for (const name of readdirSync(path).sort()) {
      visit(join(path, name), relative ? join(relative, name) : name);
    }
  };
  visit(root, "");
  return entries;
}

function writeLegacySession(
  home: string,
  workspaceRoot: string,
  sessionId: string,
  opts: {
    createdAtMs?: number;
    updatedAtMs?: number;
    historyLen?: number;
  } = {},
): void {
  const sessionDir = join(home, ".handwork", "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".handwork"), 0o700);
  chmodSync(join(home, ".handwork", "sessions"), 0o700);
  chmodSync(sessionDir, 0o700);
  const historyLen = opts.historyLen ?? 0;
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify({
      schema_version: 2,
      id: sessionId,
      created_at_ms: opts.createdAtMs ?? 1,
      updated_at_ms: opts.updatedAtMs ?? 2,
      workspace_root: workspaceRoot,
      conversation_language: "en",
      history_len: historyLen,
      history: historyLen > 0 ? [{ role: "user", content: "saved" }] : [],
      total_input_tokens: 0,
      total_output_tokens: 0,
    }) + "\n",
    { mode: 0o600 },
  );
}

function writeConversationSession(
  home: string,
  workspaceRoot: string,
  sessionId: string,
  opts: {
    createdAtMs?: number;
    updatedAtMs?: number;
    title?: string | null;
    conversationLanguage?: string;
    turns?: string[];
  } = {},
): void {
  const sessionDir = join(home, ".handwork", "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".handwork"), 0o700);
  chmodSync(join(home, ".handwork", "sessions"), 0o700);
  chmodSync(sessionDir, 0o700);
  writeFileSync(
    join(sessionDir, "session.json"),
    JSON.stringify({
      schema_version: 4,
      id: sessionId,
      origin_workspace_root: workspaceRoot,
      workspace_root: workspaceRoot,
      created_at_ms: opts.createdAtMs ?? 1,
      updated_at_ms: opts.updatedAtMs ?? 2,
      conversation_language: opts.conversationLanguage ?? "en",
      provider: "codex",
      model: FAKE_CODEX_MODEL,
      effort: "auto",
      fast_mode: false,
      title: opts.title ?? null,
      subagent_child: false,
    }) + "\n",
    { mode: 0o600 },
  );

  let seq = 0;
  const frames: string[] = [];
  for (const text of opts.turns ?? []) {
    const append = (event: object): void => {
      seq += 1;
      frames.push(JSON.stringify({
        schema_version: 1,
        seq,
        timestamp_ms: opts.updatedAtMs ?? 2,
        event,
      }));
    };
    append({ user: { text, images: [], work_id: null } });
    append({ assistant: { text: "done" } });
    append({ turn_completed: {} });
  }
  const eventsPath = join(sessionDir, "events.jsonl");
  writeFileSync(
    eventsPath,
    frames.length > 0 ? `${frames.join("\n")}\n` : "",
    { mode: 0o600 },
  );
  const updatedSeconds = (opts.updatedAtMs ?? 2) / 1000;
  utimesSync(eventsPath, updatedSeconds, updatedSeconds);
  writeFileSync(join(sessionDir, "session.lock"), "", { mode: 0o600 });
}

describe("cli: help", () => {
  

  test(
    "handwork ask help renders documented options through both aliases",
    async () => {
      const env = {
        ...NO_PROVIDER_AUTH,
        HANDWORK_DISABLE_KEYCHAIN: "1",
      };
      const expected = `handwork ask

Run one noninteractive request

Usage:
  handwork ask [--auto|--full-access] [--image PATH] [--system TEXT] [--json] [--quiet] [--prompt-permissions] [--no-save] [--no-color] [--resume <last|id>|--resume-id <id>] [--continue-recovery] [--] <prompt>

Options:
  --auto                Automatically review unresolved permission requests
  --full-access         Disable handwork permission checks
  --yolo                Alias for --full-access
  --image PATH          Attach an image file; repeat for multiple images
  --system TEXT         Replace the built-in system prompt for this request
  --json                Emit machine-readable JSON instead of text
  --quiet               Suppress assistant output
  --prompt-permissions  Prompt for Y/N permission approval when stdin is a TTY
  --no-save             Do not save the session; incompatible with --resume and --resume-id
  --no-color            Render TTY output without colors or hyperlinks
  --resume <last|id>    Continue the last session or a session by id
  --resume-id <id>      Continue a session by exact id
  --continue-recovery   Resume the paused model response in the selected session
  --                    Treat every following argument as prompt text

The prompt may be passed as arguments or piped on stdin when no prompt args are given.
TTY stdout uses the Minimal transcript presentation; redirected stdout emits raw assistant Markdown.
Operational progress and diagnostics are written to stderr. JSON \`output\` keeps accumulated assistant Markdown; \`final_output\` contains only the completed final response, or an empty string when absent.
JSON usage sums reported main-agent input_tokens and output_tokens, including with --no-save; unreported counts are null. Nested usage and dollar spend are excluded.
--system replaces only the built-in base prompt for this request; tool, skill, project, and runtime context still apply.
With --prompt-permissions, JSON and quiet requests may prompt on stderr only when stdin is a TTY.
`;

      for (const alias of ["--help", "-h"]) {
        const result = await runHandwork(["ask", alias], { env });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe(expected);
      }
    },
    TIMEOUT,
  );

  test(
    "handwork session help documents inspect resume migrate and recover",
    async () => {
      for (const args of [
        ["session", "--help"],
        ["session", "resume", "--help"],
      ]) {
        const r = await runHandwork(args);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain("Inspect, resume, migrate, or recover saved sessions");
        expect(r.stdout).toContain("session <last|id>|--id <id>");
        expect(r.stdout).toContain("session resume [last|<id>]");
        expect(r.stdout).toContain("session migrate <id>|--id <id>");
        expect(r.stdout).toContain("session recover <id>|--id <id>");
      }
    },
    TIMEOUT,
  );

  test(
    "handwork acp help documents accepted options",
    async () => {
      for (const alias of ["--help", "-h"]) {
        const r = await runHandwork(["acp", alias]);
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain(
          "Usage:\n  handwork acp [--model <id>] [--log-file <path>]",
        );
        expect(r.stdout).toContain("--model <id>");
        expect(r.stdout).toContain("--log-file <path>");
      }
    },
    TIMEOUT,
  );

  test(
    "handwork replay help describes golden output",
    async () => {
      const r = await runHandwork(["replay", "--help"]);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toContain("--golden <path>");
      expect(r.stdout).toContain("Write the final rendered grid to a file");
      expect(r.stdout).not.toContain("Compare output against a golden file");
    },
    TIMEOUT,
  );

  test(
    "handwork acp rejects unknown options and missing option values",
    async () => {
      for (const args of [["--bogus"], ["--model"], ["--log-file"]]) {
        const result = await runHandwork(["acp", ...args]);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          "usage: handwork acp [--model <id>] [--log-file <path>]\n",
        );
      }
    },
    TIMEOUT,
  );

  for (const alias of ["help", "--help", "-h"]) {
    test(
      `handwork ${alias} respects COLUMNS=60`,
      async () => {
        const r = await runHandwork([alias], { env: { COLUMNS: "60" } });
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toContain("Commands:");
        expect(r.stdout).toContain("ask");
        expect(r.stdout).toContain("setup");
        expect(r.stdout).toContain("status");
        expect(r.stdout).toContain("doctor");
        expect(maxLineWidth(r.stdout)).toBeLessThanOrEqual(60);
      },
      TIMEOUT,
    );
  }

  for (const alias of ["help", "--help", "-h"]) {
    test(
      `handwork ${alias} hides developer recording surfaces`,
      async () => {
        const r = await runHandwork([alias]);
        expect(r.code).toBe(0);
        expect(r.stdout).not.toContain("--record");
        expect(r.stdout).not.toContain("replay <tape>");
        expect(r.stderr).toBe("");
      },
      TIMEOUT,
    );
  }

  test(
    "handwork rejects the removed record flag as unknown input",
    async () => {
      const r = await runHandwork(["--record"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("handwork: unknown subcommand: --record");
      expect(r.stderr).not.toContain("visual terminal capture:");
    },
    TIMEOUT,
  );
});

describe("cli: version", () => {
  for (const alias of ["--version", "-v"]) {
    test(
      `handwork ${alias} prints the source version`,
      async () => {
        const r = await runHandwork([alias]);
        expect(r.code).toBe(0);
        expect(r.stdout).toBe(`${sourceVersion()}\n`);
        expect(r.stderr).toBe("");
      },
      TIMEOUT,
    );
  }
});

describe("cli: status", () => {
  test(
    "status and doctor expose the MCP profile error that blocks ask startup",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-mcp-config-diagnostic-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const handworkDir = join(home, ".handwork");
      mkdirSync(handworkDir, { recursive: true, mode: 0o700 });
      mkdirSync(workspace);
      writeFileSync(join(handworkDir, "mcp.json"), "{invalid json", { mode: 0o600 });
      const provider = startFakeCodex([]);

      try {
        const env = {
          HOME: realpathSync(home),
          HANDWORK_AUTH_MODE: "host-managed",

          HANDWORK_DISABLE_KEYCHAIN: "1",
          HANDWORK_AUTO_UPGRADE: "0",
          HANDWORK_MODEL: FAKE_CODEX_MODEL,
          HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
        };
        const cwd = realpathSync(workspace);
        const before = snapshotTree(home);

        const statusText = await runHandwork(["status"], { cwd, env });
        const statusJsonResult = await runHandwork(["status", "--json"], { cwd, env });
        const doctorText = await runHandwork(["doctor"], { cwd, env });
        const doctorJsonResult = await runHandwork(["doctor", "--json"], { cwd, env });
        const ask = await runHandwork(
          ["ask", "--json", "--no-save", "Do nothing."],
          { cwd, env },
        );

        for (const result of [statusText, statusJsonResult, doctorText, doctorJsonResult]) {
          expect(result.code).toBe(0);
          expect(result.stderr).toBe("");
        }
        expect(statusText.stdout).toContain(
          "[status] mcp_config_error=McpConfigInvalidJson\n",
        );
        expect(JSON.parse(statusJsonResult.stdout)).toMatchObject({
          kind: "status",
          mcp_config_error: "McpConfigInvalidJson",
        });
        expect(doctorText.stdout).toContain(
          "[fail] mcp_config: failed to load ~/.handwork/mcp.json: McpConfigInvalidJson\n",
        );
        const doctorJson = JSON.parse(doctorJsonResult.stdout);
        expect(doctorJson.fail_count).toBe(1);
        expect(
          doctorJson.checks.filter(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toEqual([
          {
            name: "mcp_config",
            status: "fail",
            detail: "failed to load ~/.handwork/mcp.json: McpConfigInvalidJson",
          },
        ]);
        expect(ask.code).toBe(1);
        expect(ask.stderr).toBe("");
        expect(JSON.parse(ask.stdout)).toMatchObject({
          exit_code: 1,
          error: "McpConfigInvalidJson",
        });
        expect(provider.requestCount()).toBe(0);
        expect(snapshotTree(home)).toEqual(before);

        writeFileSync(
          join(handworkDir, "mcp.json"),
          JSON.stringify({
            "MCP-Servers": { fixture: { command: "node" } },
          }) + "\n",
          { mode: 0o600 },
        );
        const warningStatus = await runHandwork(["status", "--json"], { cwd, env });
        const warningDoctor = await runHandwork(["doctor", "--json"], { cwd, env });
        expect(JSON.parse(warningStatus.stdout)).toMatchObject({
          mcp_config_warning: {
            cause: "suspicious_server_key",
            key: "MCP-Servers",
            additional_matches: 0,
          },
        });
        expect(
          JSON.parse(warningDoctor.stdout).checks.find(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toMatchObject({ status: "warn" });

        writeFileSync(join(handworkDir, "mcp.json"), '{"mcp":{}}\n', { mode: 0o600 });
        const validBefore = snapshotTree(home);
        const validStatus = await runHandwork(["status", "--json"], { cwd, env });
        const validDoctor = await runHandwork(["doctor", "--json"], { cwd, env });
        expect(validStatus.code).toBe(0);
        expect(validDoctor.code).toBe(0);
        expect(JSON.parse(validStatus.stdout)).not.toHaveProperty("mcp_config_error");
        expect(
          JSON.parse(validDoctor.stdout).checks.some(
            (check: { name: string }) => check.name === "mcp_config",
          ),
        ).toBe(false);
        expect(provider.requestCount()).toBe(0);
        expect(snapshotTree(home)).toEqual(validBefore);
      } finally {
        provider.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor share the missing auth snapshot",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-status-noauth-"));
      try {
        const env = {
          ...NO_PROVIDER_AUTH,
          HOME: realpathSync(root),
          HANDWORK_DISABLE_KEYCHAIN: "1",
        };
        const status = await runHandwork(["status", "--json"], { env });
        const doctor = await runHandwork(["doctor", "--json"], { env });

        expect(status.code).toBe(0);
        expect(doctor.code).toBe(0);
        const statusJson = JSON.parse(status.stdout.trim());
        const doctorJson = JSON.parse(doctor.stdout.trim());
        expect(statusJson).toMatchObject({
          auth: "missing",
          auth_refreshable: false,
          auth_help: MISSING_AUTH_MESSAGE,
        });
        expect(statusJson).not.toHaveProperty("sandbox");
        expect(doctorJson).toMatchObject({
          auth: "missing",
          auth_refreshable: false,
        });
        expect(doctorJson.checks).toContainEqual({
          name: "auth",
          status: "fail",
          detail: MISSING_AUTH_MESSAGE,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  for (const scenario of [
    { name: "Codex", provider: "codex", source: undefined, help: "handwork needs a Codex subscription login for this model. Run handwork login codex." },
    { name: "Grok", provider: "grok", source: undefined, help: "handwork needs a Grok subscription login for this model. Run handwork login grok." },
  ]) {
    test(
      `status and doctor respect ${scenario.name} when credentials are missing`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "handwork-e2e-provider-diagnostics-"));
        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          mkdirSync(join(home, ".handwork"), { recursive: true });
          mkdirSync(workspace);
          const settingsPath = join(home, ".handwork", "settings.json");
          const settings = JSON.stringify({
            provider: scenario.provider,
            models: { [scenario.provider]: "test-model" },
            credential_source: scenario.source,
          });
          writeFileSync(settingsPath, settings);
          const options = {
            cwd: realpathSync(workspace),
            env: { ...NO_PROVIDER_AUTH, HOME: realpathSync(home), HANDWORK_DISABLE_KEYCHAIN: "1" },
          };

          for (const command of ["status", "doctor"]) {
            const text = await runHandwork([command], options);
            const json = await runHandwork([command, "--json"], options);
            expect(text.code).toBe(0);
            expect(json.code).toBe(0);
            expect(text.stderr).toBe("");
            expect(json.stderr).toBe("");
            expect(text.stdout).toContain(scenario.help);
            const value = JSON.parse(json.stdout);
            expect(value.auth).toBe("missing");
            expect(value.auth_refreshable).toBe(false);
            if (command === "status") {
              expect(value.auth_help).toBe(scenario.help);
            } else {
              expect(value.checks).toContainEqual({
                name: "auth", status: "fail", detail: scenario.help,
              });
            }
          }

          const ask = await runHandwork(["ask", "--json", "--no-save", "Say hello."], options);
          expect(ask.code).toBe(1);
          expect(JSON.parse(ask.stdout).error).toBe("MissingCredentials");
          expect(ask.stderr).toContain(scenario.help);
          expect(readFileSync(settingsPath, "utf8")).toBe(settings);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }

  

  

  test(
    "status and doctor inspect an expired login without refreshing it",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-status-expired-auth-"));
      const requestCatcher = startRequestCatcher();
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        writeSeededHandworkAuth(
          home,
          "team_123",
          requestCatcher.issuerUrl,
          Date.now() - 60_000,
        );
        const env = {
          ...NO_PROVIDER_AUTH,
          HOME: realpathSync(home),
          HANDWORK_DISABLE_KEYCHAIN: "1",
          HANDWORK_E2E_OAUTH_ISSUER_URL: requestCatcher.issuerUrl,
        };
        const cwd = realpathSync(workspace);

        const status = await runHandwork(["status", "--json"], { cwd, env });
        const doctor = await runHandwork(["doctor", "--json"], { cwd, env });

        expect(status.code).toBe(0);
        expect(doctor.code).toBe(0);
        const expectedAuth = {
          auth: "handwork login",
          auth_refreshable: true,
          team: "loveconnor",
        };
        expect(JSON.parse(status.stdout.trim())).toMatchObject(expectedAuth);
        expect(JSON.parse(doctor.stdout.trim())).toMatchObject(expectedAuth);
        expect(requestCatcher.requests).toEqual([]);
      } finally {
        requestCatcher.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  

  test(
    "handwork status --json returns valid status JSON",
    async () => {
      const r = await runHandwork(["status", "--json"]);
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(json.kind).toBe("status");
      expect(json).toHaveProperty("model");
      expect(json).toHaveProperty("workspace");
      expect(json).toHaveProperty("permission_mode");
      expect(json).toHaveProperty("history_turns");
      expect(json).toHaveProperty("agent_step_limit");
      expect(json.update_channel).toBe("stable");
      expect(json.build_channel).toBe("stable");
      expect(json.build_revision).toMatch(/^[0-9a-f]{12}$/);
    },
    TIMEOUT,
  );

  test(
    "handwork status reports a persisted dev update channel",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-update-channel-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".handwork"), { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        writeFileSync(
          join(home, ".handwork", "settings.json"),
          '{"update_channel":"dev"}\n',
          { mode: 0o600 },
        );

        const result = await runHandwork(["status", "--json"], {
          cwd: realpathSync(workspace),
          env: { ...NO_PROVIDER_AUTH, HOME: home },
        });
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toMatchObject({
          kind: "status",
          update_channel: "dev",
          build_channel: "stable",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "handwork upgrade help documents release channels",
    async () => {
      const result = await runHandwork(["upgrade", "--help"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("--channel <stable|dev>");
      expect(result.stdout).toContain("Select and remember the release channel");
    },
    TIMEOUT,
  );

  test(
    "handwork status --json defaults permission mode to auto",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-permission-default-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runHandwork(["status", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_PROVIDER_AUTH,
            HOME: realpathSync(home),
            HANDWORK_PERMISSION_MODE: undefined,
          },
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.permission_mode).toBe("auto");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "status and doctor apply an exact HANDWORK_MAX_AGENT_STEPS override",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-agent-step-limit-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const env = {
          ...NO_PROVIDER_AUTH,
          HOME: realpathSync(home),
          HANDWORK_MAX_AGENT_STEPS: "3",
        };

        const status = await runHandwork(["status", "--json"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        expect(JSON.parse(status.stdout.trim()).agent_step_limit).toBe(3);

        const doctor = await runHandwork(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(doctor.code).toBe(0);
        const startup = JSON.parse(doctor.stdout.trim()).checks.find(
          (check: { name: string }) => check.name === "startup",
        );
        expect(startup.detail).toContain("agent_step_limit=3");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "project profile-only settings are ignored before parsing and profile overrides win",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-profile-config-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".handwork"), { recursive: true });
        mkdirSync(workspace);
        const homeRoot = realpathSync(home);
        const workspaceRoot = realpathSync(workspace);
        const env = {
          ...NO_PROVIDER_AUTH,
          HOME: homeRoot,
          HANDWORK_MODEL: undefined,
          HANDWORK_PERMISSION_MODE: undefined,
          HANDWORK_MAX_AGENT_STEPS: undefined,
        };

        writeFileSync(
          join(home, ".handwork", "settings.json"),
          JSON.stringify({
            model: "anthropic/claude-sonnet-4.6",
            permission_mode: "auto",
          }) + "\n",
        );
        writeFileSync(
          join(workspace, ".handwork.json"),
          JSON.stringify({
            model: 123,
            permission_mode: "danger",
            permission: { bash: true },
            statusLine: 7,
            max_agent_steps: 7,
          }) + "\n",
        );

        const status = await runHandwork(["status", "--json"], {
          cwd: workspaceRoot,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(status.code).toBe(0);
        const first = JSON.parse(status.stdout.trim());
        expect(first.model).toBe("anthropic/claude-sonnet-4.6");
        expect(first.permission_mode).toBe("auto");
        expect(first.agent_step_limit).toBe(7);
        expect(status.stderr).toContain(
          "handwork: config project: ignored_project_user_only_setting; key=model",
        );
        expect(status.stderr).toContain(
          "handwork: config project: ignored_project_user_only_setting; key=permission_mode",
        );
        expect(status.stderr).toContain(
          "handwork: config project: ignored_project_user_only_setting; key=permission",
        );
        expect(status.stderr).toContain(
          "handwork: config project: ignored_project_user_only_setting; key=statusLine",
        );
        expect(status.stderr).not.toContain("danger");

        writeFileSync(
          join(home, ".handwork", "settings.json"),
          JSON.stringify({
            model: "anthropic/claude-sonnet-4.6",
            permission_mode: "auto",
            workspaces: {
              [workspaceRoot]: {
                max_agent_steps: 4,
              },
            },
          }) + "\n",
        );

        const overridden = await runHandwork(["status", "--json"], {
          cwd: workspaceRoot,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(overridden.code).toBe(0);
        const second = JSON.parse(overridden.stdout.trim());
        expect(second.model).toBe("anthropic/claude-sonnet-4.6");
        expect(second.permission_mode).toBe("auto");
        expect(second.agent_step_limit).toBe(4);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "special settings files fail closed without blocking CLI startup",
    async () => {
      if (platform() === "win32") return;
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-config-special-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const handworkDir = join(home, ".handwork");
        mkdirSync(handworkDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(handworkDir, 0o700);

        const env = {
          ...NO_PROVIDER_AUTH,
          HOME: home,
          HANDWORK_DISABLE_KEYCHAIN: "1",
          HANDWORK_SKIP_ONBOARDING: "1",
          HANDWORK_SOUND: "0",
        };

        expect(spawnSync("mkfifo", [join(handworkDir, "settings.json")]).status).toBe(0);
        const userStartedAt = Date.now();
        const user = await runHandwork(["status", "--json"], {
          cwd: workspace,
          env,
          timeoutMs: 3_000,
        });
        expect(Date.now() - userStartedAt).toBeLessThan(3_000);
        expect(user.code).toBe(0);
        expect(JSON.parse(user.stdout)).toMatchObject({ kind: "status" });
        expect(user.stderr).toContain("handwork: config user: durable_path_unsafe");

        rmSync(join(handworkDir, "settings.json"));
        expect(spawnSync("mkfifo", [join(workspace, ".handwork.json")]).status).toBe(0);
        const projectStartedAt = Date.now();
        const project = await runHandwork(["status", "--json"], {
          cwd: workspace,
          env,
          timeoutMs: 3_000,
        });
        expect(Date.now() - projectStartedAt).toBeLessThan(3_000);
        expect(project.code).toBe(0);
        expect(JSON.parse(project.stdout)).toMatchObject({ kind: "status" });
        expect(project.stderr).toContain("handwork: config project: durable_path_unsafe");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: permissions", () => {
  test(
    "handwork permissions --json returns valid permissions JSON",
    async () => {
      const r = await runHandwork(["permissions", "--json"]);
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(json.kind).toBe("permissions");
      expect(json).toHaveProperty("mode");
      expect(json).toHaveProperty("grant_count");
      expect(json.grant_scope).toBe("session");
      expect(json.runtime_grants_available).toBe(false);
      expect(json.rules_scope).toBe("persistent_config");
      expect(Array.isArray(json.rules)).toBe(true);
      expect(Array.isArray(json.grants)).toBe(true);
    },
    TIMEOUT,
  );
});

describe("cli: doctor", () => {
  test(
    "handwork doctor --json returns valid doctor JSON",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-doctor-json-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runHandwork(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_PROVIDER_AUTH,
            HOME: realpathSync(home),
          },
          timeoutMs: TIMEOUT,
        });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("doctor");
        expect(Array.isArray(json.checks)).toBe(true);
        expect(json).toHaveProperty("ok_count");
        expect(json).toHaveProperty("warn_count");
        expect(json).toHaveProperty("fail_count");
        expect(json.checks).toContainEqual({
          name: "auth",
          status: "fail",
          detail: MISSING_AUTH_MESSAGE,
        });
        for (const check of json.checks) {
          expect(check).toHaveProperty("name");
          expect(check).toHaveProperty("status");
          expect(check).toHaveProperty("detail");
          expect(["ok", "warn", "fail"]).toContain(check.status);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "handwork doctor --json leaves an empty home unchanged",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-doctor-no-create-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);

        const r = await runHandwork(["doctor", "--json"], {
          cwd: realpathSync(workspace),
          env: {
            ...NO_PROVIDER_AUTH,
            HOME: realpathSync(home),
          },
          timeoutMs: TIMEOUT,
        });

        expect(r.code).toBe(0);
        expect(JSON.parse(r.stdout.trim()).kind).toBe("doctor");
        expect(existsSync(join(home, ".handwork"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "handwork doctor --json bounds diagnostics while reporting the cache-free session count",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-doctor-bounded-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const limit = doctorSessionDiagnosticsLimit();
        const sessionCount = limit + 32;
        for (let i = 0; i < sessionCount; i += 1) {
          writeLegacySession(
            home,
            workspaceRoot,
            `doctor-bounded-${String(i).padStart(3, "0")}`,
            { updatedAtMs: i + 1 },
          );
        }

        expect(existsSync(join(home, ".handwork", "sessions", "summary.json"))).toBe(false);

        const r = await runHandwork(["doctor", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...NO_PROVIDER_AUTH,
            HOME: home,
          },
          timeoutMs: TIMEOUT,
        });

        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout.length).toBeLessThan(64 * 1024);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("doctor");
        expect(json.checks.length).toBeLessThan(sessionCount);
        expect(json.checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "session",
              status: "warn",
              detail: expect.stringContaining(
                `truncated after ${limit} session director`,
              ),
            }),
            expect.objectContaining({
              name: "sessions",
              status: "ok",
              detail: expect.stringContaining(
                `${sessionCount} saved session(s)`,
              ),
            }),
          ]),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

// The file backend is only selected off macOS, so these run on Linux CI.

describe("cli: read-only no-create matrix", () => {
  const probes = [
    { args: ["status", "--json"], code: 0, kind: "status" },
    { args: ["sessions", "--json"], code: 0, kind: "sessions", count: 0 },
    { args: ["session", "last", "--json"], code: 1, error: "no saved sessions" },
    { args: ["session", "--id", "missing.valid-id", "--json"], code: 1, error: "record not found" },
    { args: ["doctor", "--json"], code: 0, kind: "doctor" },
  ] as const;

  for (const probe of probes) {
    test(
      `${probe.args.join(" ")} leaves an empty home unchanged`,
      async () => {
        const root = mkdtempSync(join(tmpdir(), "handwork-e2e-no-create-"));
        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          mkdirSync(home);
          mkdirSync(workspace);
          const before = snapshotTree(home);

          const result = await runHandwork([...probe.args], {
            cwd: realpathSync(workspace),
            env: {
              ...NO_PROVIDER_AUTH,
              HOME: realpathSync(home),
              HANDWORK_E2E_FAIL_ON_DURABLE_MUTATION: "1",
            },
            timeoutMs: TIMEOUT,
          });

          expect(result.code).toBe(probe.code);
          if ("kind" in probe) {
            const output = JSON.parse(result.stdout);
            expect(output.kind).toBe(probe.kind);
            if ("count" in probe) expect(output.count).toBe(probe.count);
          } else {
            const output = JSON.parse(result.stdout);
            expect(output.error).toContain(probe.error);
            expect(result.stderr).toBe("");
          }
          expect(snapshotTree(home)).toEqual(before);
          expect(existsSync(join(home, ".handwork"))).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }
});

describe("cli: missing durable home", () => {
  

  test(
    "session commands fail precisely while doctor remains available without HOME",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-no-home-"));
      try {
        const workspace = join(root, "workspace");
        mkdirSync(workspace);
        const cwd = realpathSync(workspace);
        const env = {
          ...NO_PROVIDER_AUTH,
          HOME: undefined,
        };

        for (const args of [
          ["sessions", "--json"],
          ["session", "last", "--json"],
          ["session", "--id", "missing.valid-id", "--json"],
          ["session", "migrate", "--id", "missing.valid-id", "--json"],
        ]) {
          const result = await runHandwork(args, { cwd, env, timeoutMs: TIMEOUT });
          expect(result.code).toBe(1);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout)).toEqual(
            expect.objectContaining({
              code: "HomeNotSet",
            }),
          );
        }

        const doctor = await runHandwork(["doctor", "--json"], {
          cwd,
          env,
          timeoutMs: TIMEOUT,
        });
        expect(doctor.code).toBe(0);
        expect(JSON.parse(doctor.stdout).checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "state",
              detail: expect.stringContaining("HomeNotSet"),
            }),
          ]),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: sessions", () => {
  test(
    "handwork sessions --json returns valid sessions JSON",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "handwork-e2e-sessions-empty-"));
      try {
        const r = await runHandwork(["sessions", "--json"], { env: { HOME: home } });
        expect(r.code).toBe(0);
        const json = JSON.parse(r.stdout.trim());
        expect(json.kind).toBe("sessions");
        expect(json).toHaveProperty("count");
        expect(Array.isArray(json.sessions)).toBe(true);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "handwork sessions text shows named, unnamed, and renamed sessions",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-session-names-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const sessionsDir = join(home, ".handwork", "sessions");
        mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(join(home, ".handwork"), 0o700);
        chmodSync(sessionsDir, 0o700);
        const workspaceRoot = realpathSync(workspace);
        writeConversationSession(home, workspaceRoot, "named-session", {
          title: "Investigate cache misses",
          updatedAtMs: 3,
          turns: ["first named turn", "second named turn"],
        });
        writeConversationSession(home, workspaceRoot, "unnamed-session", {
          updatedAtMs: 2,
        });
        writeConversationSession(home, workspaceRoot, "script-only-session", {
          title: "Review landing page",
          updatedAtMs: 1_700_000_000_123,
          conversationLanguage: "und-Latn",
          turns: ["review the landing page"],
        });

        const first = await runHandwork(["sessions"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        expect(first.stdout).toContain(
          " - Investigate cache misses\n   id=named-session | 2 turns | English | updated 1970-01-01 00:00:00.003 UTC",
        );
        expect(first.stdout).toContain(
          " - Untitled session\n   id=unnamed-session | 0 turns | English | updated 1970-01-01 00:00:00.002 UTC",
        );
        expect(first.stdout).toContain(
          " - Review landing page\n   id=script-only-session | 1 turn | Latin script | updated 2023-11-14 22:13:20.123 UTC",
        );
        expect(first.stdout).not.toContain("updated_at_ms");
        expect(first.stdout).not.toContain("language=");

        const structured = await runHandwork(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(structured.code).toBe(0);
        expect(structured.stderr).toBe("");
        expect(JSON.parse(structured.stdout).sessions[0]).toMatchObject({
          id: "script-only-session",
          updated_at_ms: 1_700_000_000_123,
          conversation_language: "und-Latn",
        });

        const namedPath = join(sessionsDir, "named-session", "session.json");
        const renamedMetadata = JSON.parse(readFileSync(namedPath, "utf8"));
        renamedMetadata.title = "Investigate cache hits";
        writeFileSync(namedPath, JSON.stringify(renamedMetadata) + "\n", {
          mode: 0o600,
        });
        const renamed = await runHandwork(["sessions"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(renamed.code).toBe(0);
        expect(renamed.stderr).toBe("");
        expect(renamed.stdout).toContain(
          " - Investigate cache hits\n   id=named-session | 2 turns | English",
        );
        expect(renamed.stdout).not.toContain("Investigate cache misses");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session listing pages direct metadata without an index",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-session-pages-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const sessionsDir = join(home, ".handwork", "sessions");
        mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
        mkdirSync(workspace);
        chmodSync(join(home, ".handwork"), 0o700);
        chmodSync(sessionsDir, 0o700);
        const workspaceRoot = realpathSync(workspace);
        for (let index = 0; index < 201; index += 1) {
          const id = `direct-session-${index.toString().padStart(5, "0")}`;
          writeConversationSession(home, workspaceRoot, id, {
            title: id,
            createdAtMs: 20_000 - index,
            updatedAtMs: 20_000 - index,
          });
        }
        expect(existsSync(join(sessionsDir, "index.json"))).toBe(false);

        const first = await runHandwork(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(first.code).toBe(0);
        expect(Buffer.byteLength(first.stdout)).toBeLessThan(100_000);
        const firstJson = JSON.parse(first.stdout) as {
          count: number;
          has_more: boolean;
          next_cursor: string;
          sessions: Array<{ id: string; history_len: number }>;
        };
        expect(firstJson.count).toBe(100);
        expect(firstJson.has_more).toBe(true);
        expect(firstJson.sessions).toHaveLength(100);
        expect(firstJson.sessions[0]).toMatchObject({
          id: "direct-session-00000",
          history_len: 0,
        });
        expect(firstJson.sessions[99].id).toBe("direct-session-00099");

        const second = await runHandwork(
          ["sessions", "--json", "--cursor", firstJson.next_cursor],
          {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_PROVIDER_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(second.code).toBe(0);
        const secondJson = JSON.parse(second.stdout) as {
          count: number;
          has_more: boolean;
          sessions: Array<{ id: string }>;
        };
        expect(secondJson.count).toBe(100);
        expect(secondJson.has_more).toBe(true);
        expect(secondJson.sessions[0].id).toBe("direct-session-00100");
        expect(secondJson.sessions[99].id).toBe("direct-session-00199");

        const one = await runHandwork(["sessions", "--json", "--limit", "1"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(one.code).toBe(0);
        expect(JSON.parse(one.stdout)).toMatchObject({
          count: 1,
          has_more: true,
          sessions: [{ id: "direct-session-00000" }],
        });

        const invalid = await runHandwork(["sessions", "--limit", "0"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(invalid.code).not.toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session lists use projections without opening unreadable event logs",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-session-projections-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const fixture = spawnSync(
          "python3",
          [
            join(REPO_ROOT, "benchmarks", "session_list_fixture.py"),
            "--home",
            home,
            "--workspace",
            workspaceRoot,
            "--sessions",
            "2",
            "--log-size",
            "4096",
            "--deny-event-read",
          ],
          { encoding: "utf8" },
        );
        expect(fixture.status).toBe(0);

        const before = snapshotTree(join(home, ".handwork"));
        const listed = await runHandwork(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toEqual({
          kind: "sessions",
          count: 2,
          sessions: [
            {
              id: "benchmark-session-01",
              title: "Benchmark session 01",
              preview: "Benchmark session 01 preview",
              workspace_root: workspaceRoot,
              origin_workspace_root: workspaceRoot,
              created_at_ms: 1001,
              updated_at_ms: 2001,
              history_len: 1,
              conversation_language: "en",
            },
            {
              id: "benchmark-session-00",
              title: "Benchmark session 00",
              preview: "Benchmark session 00 preview",
              workspace_root: workspaceRoot,
              origin_workspace_root: workspaceRoot,
              created_at_ms: 1000,
              updated_at_ms: 2000,
              history_len: 0,
              conversation_language: "en",
            },
          ],
        });
        expect(snapshotTree(join(home, ".handwork"))).toEqual(before);

        const latest = await runHandwork(["session", "last", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home },
          timeoutMs: TIMEOUT,
        });
        expect(latest.code).toBe(0);
        expect(JSON.parse(latest.stdout)).toEqual({
          kind: "session_summary",
          id: "benchmark-session-01",
          title: "Benchmark session 01",
          preview: "Benchmark session 01 preview",
          workspace_root: workspaceRoot,
          origin_workspace_root: workspaceRoot,
          created_at_ms: 1001,
          updated_at_ms: 2001,
          history_len: 1,
          conversation_language: "en",
        });
        expect(snapshotTree(join(home, ".handwork"))).toEqual(before);

        const detail = await runHandwork(
          ["session", "--id", "benchmark-session-00", "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home },
            timeoutMs: TIMEOUT,
          },
        );
        expect(detail.code).not.toBe(0);
        expect(detail.stderr).toContain("AccessDenied");
        expect(snapshotTree(join(home, ".handwork"))).toEqual(before);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "workspace-scoped session discovery filters list and last by cwd",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-workspace-sessions-"));
      try {
        const home = join(root, "home");
        const workspaceA = join(root, "workspace-a");
        const workspaceB = join(root, "workspace-b");
        mkdirSync(home);
        mkdirSync(workspaceA);
        mkdirSync(workspaceB);
        const workspaceARoot = realpathSync(workspaceA);
        const workspaceBRoot = realpathSync(workspaceB);

        writeLegacySession(home, workspaceARoot, "workspace-a-older", {
          updatedAtMs: 20,
        });
        writeLegacySession(home, workspaceARoot, "workspace-a-latest", {
          updatedAtMs: 40,
        });
        writeLegacySession(home, workspaceBRoot, "workspace-b-newest", {
          updatedAtMs: 80,
        });

        const listA = await runHandwork(["sessions", "--json"], {
          cwd: workspaceARoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listA.code).toBe(0);
        const jsonA = JSON.parse(listA.stdout);
        expect(jsonA.kind).toBe("sessions");
        expect(jsonA.count).toBe(2);
        expect(jsonA.sessions.map((session: { id: string }) => session.id))
          .toEqual(["workspace-a-latest", "workspace-a-older"]);

        const lastA = await runHandwork(["session", "last", "--json"], {
          cwd: workspaceARoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(lastA.code).toBe(0);
        expect(JSON.parse(lastA.stdout).id).toBe("workspace-a-latest");

        const listB = await runHandwork(["sessions", "--json"], {
          cwd: workspaceBRoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listB.code).toBe(0);
        const jsonB = JSON.parse(listB.stdout);
        expect(jsonB.count).toBe(1);
        expect(jsonB.sessions.map((session: { id: string }) => session.id))
          .toEqual(["workspace-b-newest"]);

        const exactForeign = await runHandwork(
          ["session", "--id", "workspace-b-newest", "--json"],
          {
            cwd: workspaceARoot,
            env: { HOME: home, ...NO_PROVIDER_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(exactForeign.code).toBe(0);
        expect(JSON.parse(exactForeign.stdout).id).toBe("workspace-b-newest");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "session discovery reports corrupt records and distinguishes an unreadable latest session",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-corrupt-sessions-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        writeLegacySession(home, workspaceRoot, "readable-session", {
          updatedAtMs: 30,
        });
        for (const [id, contents] of [
          ["invalid-json", "{"],
          ["truncated", '{"schema_version":2,"id":"truncated"}'],
        ] as const) {
          const directory = join(home, ".handwork", "sessions", id);
          mkdirSync(directory, { recursive: true, mode: 0o700 });
          writeFileSync(join(directory, "session.json"), contents, {
            mode: 0o600,
          });
        }

        const listed = await runHandwork(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout)).toMatchObject({
          kind: "sessions",
          count: 1,
          skipped_invalid: 2,
          sessions: [{ id: "readable-session" }],
        });

        rmSync(join(home, ".handwork", "sessions", "readable-session"), {
          recursive: true,
          force: true,
        });
        const latest = await runHandwork(["session", "last", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(latest.code).toBe(1);
        expect(latest.stderr).toBe("");
        expect(JSON.parse(latest.stdout)).toMatchObject({
          error: expect.stringContaining("saved sessions are unreadable"),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "profile-wide session discovery recovers sessions after a workspace rename",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-renamed-workspace-"));
      try {
        const home = join(root, "home");
        const original = join(root, "workspace-before");
        const renamed = join(root, "workspace-after");
        mkdirSync(home);
        mkdirSync(original);
        const originalRoot = realpathSync(original);
        writeLegacySession(home, originalRoot, "renamed-workspace-session", {
          updatedAtMs: 40,
        });
        renameSync(original, renamed);
        const renamedRoot = realpathSync(renamed);

        const scoped = await runHandwork(["sessions", "--json"], {
          cwd: renamedRoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(JSON.parse(scoped.stdout)).toMatchObject({ count: 0, sessions: [] });

        const recovered = await runHandwork(["sessions", "--all", "--json"], {
          cwd: renamedRoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: TIMEOUT,
        });
        expect(recovered.code).toBe(0);
        expect(JSON.parse(recovered.stdout)).toMatchObject({
          count: 1,
          sessions: [
            {
              id: "renamed-workspace-session",
              workspace_root: originalRoot,
            },
          ],
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "handwork sessions --json ignores malformed and oversized list caches",
    async () => {
      for (const cached of ["{", "x".repeat(4 * 1024 * 1024 + 1)]) {
        const root = mkdtempSync(join(tmpdir(), "handwork-e2e-sessions-cache-"));
        try {
          const home = join(root, "home");
          const workspace = join(root, "workspace");
          mkdirSync(join(home, ".handwork", "sessions"), { recursive: true });
          mkdirSync(workspace, { recursive: true });
          writeFileSync(join(home, ".handwork", "sessions", "list.json"), cached);

          const r = await runHandwork(["sessions", "--json"], {
            cwd: realpathSync(workspace),
            env: { HOME: home },
            timeoutMs: TIMEOUT,
          });
          expect(r.code).toBe(0);
          expect(JSON.parse(r.stdout.trim())).toEqual({
            kind: "sessions",
            count: 0,
            sessions: [],
          });
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );

  test(
    "exact session flags address special-token and 255-byte IDs literally",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-session-exact-ids-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const ids = [
          "last",
          "migrate",
          "--json",
          "--allow-large",
          "x".repeat(255),
        ];
        for (const id of ids) writeLegacySession(home, workspaceRoot, id);

        for (const id of ids) {
          const result = await runHandwork(
            ["session", "--id", id, "--json"],
            {
              cwd: workspaceRoot,
              env: { HOME: home },
              timeoutMs: TIMEOUT,
            },
          );
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout).id).toBe(id);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "expected json failures emit machine-readable stdout",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-json-errors-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const cases: Array<{
          args: string[];
          kind: string;
          expectedError?: string;
        }> = [
          { args: ["session", "last", "--json"], kind: "session" },
          {
            args: ["ask", "--json"],
            kind: "ask",
            expectedError: "MissingPrompt",
          },
          {
            args: ["ask", "--json", "--no-save", "--resume", "last", "hello"],
            kind: "ask",
            expectedError: "InvalidAskArgs",
          },
        ];

        for (const item of cases) {
          const result = await runHandwork(item.args, {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_PROVIDER_AUTH },
            timeoutMs: TIMEOUT,
          });
          expect(result.code).toBe(1);
          expect(result.stdout.trim().length).toBeGreaterThan(0);
          const parsed = JSON.parse(result.stdout.trim());
          expect(parsed.kind ?? item.kind).toBe(item.kind);
          expect(typeof parsed.error).toBe("string");
          if (item.expectedError) expect(parsed.error).toBe(item.expectedError);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: removed task and background commands", () => {
  test(
    "handwork task, handwork tasks, and handwork background are unknown commands",
    async () => {
      for (const command of ["task", "tasks", "background"]) {
        const result = await runHandwork([command], { env: NO_PROVIDER_AUTH });
        expect(result.code).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toContain("unknown subcommand");
      }
    },
    TIMEOUT,
  );

  test(
    "legacy tasks files are ignored by ordinary session loading",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-legacy-tasks-ignored-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        const workspaceRoot = realpathSync(workspace);
        writeLegacySession(home, workspaceRoot, "legacy-tasks-session");
        const tasksDir = join(home, ".handwork", "sessions", "legacy-tasks-session", "tasks");
        mkdirSync(tasksDir, { recursive: true });
        writeFileSync(join(tasksDir, "unreadable-legacy-shape.json"), "not json\n");

        const result = await runHandwork(
          ["session", "--id", "legacy-tasks-session", "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home, ...NO_PROVIDER_AUTH },
            timeoutMs: TIMEOUT,
          },
        );
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).id).toBe("legacy-tasks-session");
        expect(existsSync(join(tasksDir, "unreadable-legacy-shape.json"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: replay failures", () => {
  test(
    "handwork replay --json preserves structured failures for missing and malformed tapes",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-replay-json-errors-"));
      try {
        const missing = await runHandwork(["replay", join(root, "missing.fxtape"), "--json"]);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toBe("");
        expect(JSON.parse(missing.stdout.trim())).toMatchObject({
          kind: "replay",
          code: "FileNotFound",
        });

        const malformedPath = join(root, "malformed.fxtape");
        writeFileSync(malformedPath, "not a tape");
        const malformed = await runHandwork(["replay", malformedPath, "--json"]);
        expect(malformed.code).toBe(1);
        expect(malformed.stderr).toBe("");
        expect(JSON.parse(malformed.stdout.trim())).toMatchObject({
          kind: "replay",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: ask input validation", () => {
  
});

describe("cli: session", () => {
  test(
    "handwork session with no id exits non-zero or shows usage",
    async () => {
      const r = await runHandwork(["session"]);
      expect(r.code).not.toBe(0);
    },
    TIMEOUT,
  );

  test(
    "handwork session exact id hides managed child detail",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-private-child-detail-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(join(home, ".handwork", "sessions"), {
          recursive: true,
          mode: 0o700,
        });
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const parentId = "visible-parent";
        const childId = "private-child";

        writeLegacySession(home, workspaceRoot, parentId);
        writeLegacySession(home, workspaceRoot, childId);
        const childControl = join(
          home,
          ".handwork",
          "sessions",
          childId,
          "subagent",
        );
        mkdirSync(childControl, { recursive: true, mode: 0o700 });
        writeFileSync(
          join(childControl, "owner.json"),
          JSON.stringify({ schema_version: 1, parent_id: parentId }),
          { mode: 0o600 },
        );

        const parent = await runHandwork(
          ["session", "--id", parentId, "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home, HANDWORK_DISABLE_KEYCHAIN: "1" },
          },
        );
        expect(parent).toMatchObject({ code: 0, stderr: "" });
        expect(JSON.parse(parent.stdout)).toMatchObject({
          kind: "session_detail",
          id: parentId,
        });

        const child = await runHandwork(
          ["session", "--id", childId, "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: home, HANDWORK_DISABLE_KEYCHAIN: "1" },
          },
        );
        expect(child.code).toBe(1);
        expect(child.stderr).toBe("");
        expect(JSON.parse(child.stdout)).toEqual({
          kind: "session",
          error: "record not found",
          code: "SessionNotFound",
        });
        expect(child.stdout).not.toContain(childId);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: interactive startup", () => {
  test(
    "interactive startup without TTY exits one",
    async () => {
      const cases = [
        [],
        ["resume", "last"],
        ["--resume"],
        ["session", "resume", "last"],
        ["session", "resume", "--id", "session.v3"],
      ];

      for (const args of cases) {
        const home = realpathSync(mkdtempSync(join(tmpdir(), "handwork-e2e-no-tty-")));
        try {
          const r = await runHandwork(args, { env: { HOME: home } });
          expect(r.code).toBe(1);
          expect(r.stdout).toBe("");
          expect(r.stderr).toBe("handwork requires an interactive terminal (TTY).\n");
          expect(readdirSync(home)).toEqual([]);
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );
});

describe("cli: pr", () => {
  
});

describe("cli: issue", () => {
  
});

describe("cli: ask success", () => {
  test(
    "handwork ask binds an explicitly invoked skill into the prompt",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-ask-explicit-skill-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const skillDirectory = join(home, ".handwork", "skills", "cli-explicit");
      const skillBody = "CLI_EXPLICIT_SKILL_BODY";
      const provider = startFakeCodex([
        fakeCodexFinalText("explicit skill ask complete"),
      ]);
      try {
        mkdirSync(skillDirectory, { recursive: true });
        mkdirSync(workspace);
        writeFileSync(
          join(skillDirectory, "SKILL.md"),
          `---\nname: cli-explicit\ndescription: explicit CLI fixture\n---\n\n${skillBody}\n`,
        );

        const result = await runHandwork(
          [
            "ask",
            "--json",
            "--auto",
            "--no-save",
            "$cli-explicit apply the selected skill.",
          ],
          {
            cwd: realpathSync(workspace),
            env: {
              HOME: realpathSync(home),
              HANDWORK_AUTH_MODE: "host-managed",

              HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
              HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
              HANDWORK_MODEL: FAKE_CODEX_MODEL,
              HANDWORK_AUTO_UPGRADE: "0",
            },
            timeoutMs: TIMEOUT,
          },
        );

        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout).output.trim()).toBe(
          "explicit skill ask complete",
        );
        expect(provider.requests).toHaveLength(1);
        expect(provider.modelRequests).toHaveLength(1);
        expect(provider.requests[0]!.body).toContain(
          "Explicitly invoked skill content for this query:",
        );
        expect(provider.requests[0]!.body).toContain(
          '<skill_content name=\\"cli-explicit\\"',
        );
        expect(provider.requests[0]!.body).toContain('resource=\\"SKILL.md\\"');
        expect(provider.requests[0]!.body).toContain('complete=\\"true\\"');
        expect(provider.requests[0]!.body).toContain(skillBody);
      } finally {
        provider.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  

  test(
    "handwork ask stdin resource overflow has distinct text and JSON errors",
    async () => {
      const oversized = Buffer.alloc(8 * 1024 * 1024 + 1, 0x78);

      const textResult = await runHandwork(["ask", "--auto", "--no-save"], {
        env: { ...NO_PROVIDER_AUTH, HANDWORK_DISABLE_KEYCHAIN: "1" },
        stdin: oversized,
        timeoutMs: 60_000,
      });
      expect(textResult.code).toBe(1);
      expect(textResult.stdout).toBe("");
      expect(textResult.stderr).toBe(
        "handwork ask: prompt exceeds the local input safety limit\n",
      );

      const jsonResult = await runHandwork(["ask", "--json", "--auto", "--no-save"], {
        env: { ...NO_PROVIDER_AUTH, HANDWORK_DISABLE_KEYCHAIN: "1" },
        stdin: oversized,
        timeoutMs: 60_000,
      });
      expect(jsonResult.code).toBe(1);
      expect(jsonResult.stderr).toBe("");
      expect(jsonResult.stdout).toBe(
        '{"output":"","final_output":"","exit_code":1,"model":"","session_id":"","steps":0,"tool_calls":[],"usage":{"input_tokens":null,"output_tokens":null},"error":"PromptResourceLimitExceeded"}\n',
      );
    },
    120_000,
  );

  

  test.each([
    {
      name: "reports exact provider totals",
      reportedUsage: { inputTokens: { total: 17 }, outputTokens: { total: 23 } },
      expectedUsage: { input_tokens: 17, output_tokens: 23 },
      toolLoop: false,
      json: true,
    },
    {
      name: "reports null when provider totals are missing",
      reportedUsage: undefined,
      expectedUsage: { input_tokens: null, output_tokens: null },
      toolLoop: false,
      json: true,
    },
    {
      name: "sums main-agent completions across a read_file tool loop",
      reportedUsage: { inputTokens: { total: 17 }, outputTokens: { total: 23 } },
      expectedUsage: { input_tokens: 20, output_tokens: 28 },
      toolLoop: true,
      json: true,
    },
    {
      name: "leaves plain output unchanged",
      reportedUsage: { inputTokens: { total: 17 }, outputTokens: { total: 23 } },
      expectedUsage: undefined,
      toolLoop: false,
      json: false,
    },
  ])(
    "handwork ask usage $name",
    async ({ reportedUsage, expectedUsage, toolLoop, json }) => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-ask-usage-"));
      const answer = "Usage fixture complete.\n";
      const provider = startFakeCodex([
        fakeCodexSse([
          toolLoop
            ? { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "read_usage_fixture", name: "read_file", arguments: JSON.stringify(JSON.stringify({ path: "fixture.txt" })) } }
            : { type: "response.output_text.delta", delta: answer },
          { type: "response.completed", response: { status: "completed", usage: { input_tokens: (reportedUsage).inputTokens?.total ?? 0, output_tokens: (reportedUsage).outputTokens?.total ?? 0 } } },
        ]),
        ...(toolLoop ? [fakeCodexFinalText(answer)] : []),
      ]);
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        writeFileSync(join(workspace, "fixture.txt"), "usage fixture contents\n");

        const result = await runHandwork(
          [
            "ask",
            ...(json ? ["--json"] : []),
            "--auto",
            "--no-save",
            toolLoop ? "Read fixture.txt and reply." : "Reply with the fixture answer.",
          ],
          {
            cwd: realpathSync(workspace),
            env: {
              HOME: realpathSync(home),
              HANDWORK_AUTH_MODE: "host-managed",

              HANDWORK_DISABLE_KEYCHAIN: "1",
              HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
              HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
              HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
              HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
              HANDWORK_MODEL: FAKE_CODEX_MODEL,
              HANDWORK_AUTO_UPGRADE: "0",
            },
            timeoutMs: 60_000,
          },
        );

        expect(result.code).toBe(0);
        if (json) {
          const output = JSON.parse(result.stdout);
          expect(output.output).toBe(answer);
          expect(output.final_output).toBe(answer.trimEnd());
          expect(output.exit_code).toBe(0);
          expect(output.session_id).toBe("");
          expect(output.usage).toEqual(expectedUsage);
          expect(output.tool_calls).toEqual(
            toolLoop ? [{ name: "read_file", status: "success" }] : [],
          );
        } else {
          expect(result.stdout).toBe(answer);
        }
        if (toolLoop) {
          expect(result.stderr).toContain("Reading fixture.txt");
          expect(provider.requests[1]!.body).toContain("usage fixture contents");
        } else {
          expect(result.stderr).toBe("");
        }
        expect(provider.requests).toHaveLength(toolLoop ? 2 : 1);
        expect(provider.classifierRequests).toHaveLength(0);
        expect(existsSync(join(home, ".handwork"))).toBe(false);
      } finally {
        provider.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  test(
    "saved ask resumes the exact session while no-save creates no durable state",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-ask-persistence-"));
      const provider = startFakeCodex([
        fakeCodexFinalText("orange triangle"),
        fakeCodexFinalText("blue circle"),
        fakeCodexFinalText("green square"),
      ]);
      try {
        const savedHome = join(root, "saved-home");
        const noSaveHome = join(root, "no-save-home");
        const workspace = join(root, "workspace");
        mkdirSync(savedHome);
        mkdirSync(noSaveHome);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);

        const first = await runHandwork(
          ["ask", "--json", "--auto", "Reply with exactly: orange triangle"],
          {
            cwd: workspaceRoot,
            env: {
              HOME: realpathSync(savedHome),
              HANDWORK_AUTH_MODE: "host-managed",

              HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
              HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
              HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
              HANDWORK_MODEL: FAKE_CODEX_MODEL,
              HANDWORK_AUTO_UPGRADE: "0",
            },
            timeoutMs: 60_000,
          },
        );
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        const firstJson = JSON.parse(first.stdout.trim());
        expect(firstJson.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
        expect(typeof firstJson.session_id).toBe("string");
        expect(firstJson.session_id.length).toBeGreaterThan(0);
        expect(provider.requests[0]?.headers.get("x-session-id")).toBe(
          firstJson.session_id,
        );
        expect(provider.requests[0]?.headers.get("x-session-affinity")).toBe(
          firstJson.session_id,
        );
        expect(
          provider.requests[0]?.headers.get("x-handwork-provider-extended-time"),
        ).toBe("true");
        expect(
          existsSync(
            join(savedHome, ".handwork", "sessions", firstJson.session_id),
          ),
        ).toBe(true);

        const resumed = await runHandwork(
          [
            "ask",
            "--json",
            "--auto",
            "--resume",
            "last",
            "Reply with exactly: blue circle",
          ],
          {
            cwd: workspaceRoot,
            env: {
              HOME: realpathSync(savedHome),
              HANDWORK_AUTH_MODE: "host-managed",

              HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
              HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
              HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
              HANDWORK_MODEL: FAKE_CODEX_MODEL,
              HANDWORK_AUTO_UPGRADE: "0",
            },
            timeoutMs: 60_000,
          },
        );
        expect(resumed.code).toBe(0);
        expect(resumed.stderr).toBe("");
        const resumedJson = JSON.parse(resumed.stdout.trim());
        expect(resumedJson.session_id).toBe(firstJson.session_id);
        expect(resumedJson.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
        expect(provider.requests[1]?.headers.get("x-session-id")).toBe(
          firstJson.session_id,
        );
        expect(provider.requests[1]?.headers.get("x-session-affinity")).toBe(
          firstJson.session_id,
        );
        const detail = await runHandwork(
          ["session", "--id", firstJson.session_id, "--json"],
          {
            cwd: workspaceRoot,
            env: { HOME: realpathSync(savedHome) },
            timeoutMs: 60_000,
          },
        );
        expect(detail.code).toBe(0);
        expect(JSON.parse(detail.stdout).history_len).toBe(2);

        const noSave = await runHandwork(
          ["ask", "--json", "--auto", "--no-save", "Reply with exactly: green square"],
          {
            cwd: workspaceRoot,
            env: {
              HOME: realpathSync(noSaveHome),
              HANDWORK_AUTH_MODE: "host-managed",

              HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
              HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
              HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
              HANDWORK_MODEL: FAKE_CODEX_MODEL,
              HANDWORK_AUTO_UPGRADE: "0",
            },
            timeoutMs: 60_000,
          },
        );
        expect(noSave.code).toBe(0);
        expect(noSave.stderr).toBe("");
        const noSaveJson = JSON.parse(noSave.stdout.trim());
        expect(noSaveJson.session_id).toBe("");
        expect(noSaveJson.usage).toEqual({ input_tokens: 3, output_tokens: 5 });
        expect(provider.requests[2]?.headers.get("x-session-id")).toBeNull();
        expect(provider.requests[2]?.headers.get("x-session-affinity")).toBeNull();
        expect(existsSync(join(noSaveHome, ".handwork"))).toBe(false);
        expect(provider.requests).toHaveLength(3);
      } finally {
        provider.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );

  test(
    "saved ask converts a legacy session once and continues after restart",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-ask-legacy-convert-"));
      const provider = startFakeCodex([
        fakeCodexFinalText("LEGACY_CONVERTED_OK"),
        fakeCodexFinalText("LEGACY_RESTART_OK"),
      ]);
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const sessionId = "legacy-ask-convert";
        writeLegacySession(home, workspaceRoot, sessionId);
        const sessionDir = join(home, ".handwork", "sessions", sessionId);
        const legacyPath = join(sessionDir, "session.json");
        const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
        const legacyOutput = "LEGACY_AVAILABLE_RESULT_BYTES";
        const legacySummary = "LEGACY_ONLY_EARLIER_CONTEXT: deploy to eu-west-1.";
        legacy.history_len = 2;
        legacy.history = [{
          kind: "compacted_summary",
          summary: legacySummary,
          removed_turn_count: 12,
          compaction_count: 1,
        }, {
          kind: "assistant",
          user: { text: "LEGACY_ORIGINAL_REQUEST", images: [] },
          assistant: "LEGACY_ORIGINAL_ANSWER",
          execution: {
            schema_version: 2,
            tool_steps: [{
              assistant: null,
              tool_calls: [{ id: "legacy-read", name: "read_file", arguments_json: '{"path":"past.txt"}', provider_result: null }],
              tool_results: [{
                tool_call_id: "legacy-read", tool_name: "read_file", status: "success",
                output: legacyOutput, output_handle: null, preview: null,
                output_bytes: legacyOutput.length, stored_output_bytes: legacyOutput.length,
                truncated: false, provider_native: false, created_at_ms: 2, permission_feedback: [],
              }],
            }],
            files: [
              { path: "", new_path: null, tool_call_id: "legacy-read", tool_name: "read_file", action: "unknown", status: "success", model_view_covers_full_file: false, stale: false },
              { path: "past.txt", new_path: null, tool_call_id: "legacy-read", tool_name: "read_file", action: "unknown", status: "success", model_view_covers_full_file: false, stale: false },
            ], steering: [],
          },
        }];
        writeFileSync(legacyPath, JSON.stringify(legacy) + "\n", { mode: 0o600 });
        const env = {
          HOME: home,
          HANDWORK_AUTH_MODE: "host-managed",

          HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
          HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
          HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
          HANDWORK_MODEL: FAKE_CODEX_MODEL,
          HANDWORK_AUTO_UPGRADE: "0",
        };

        const first = await runHandwork(
          ["ask", "--json", "--auto", "--resume-id", sessionId, "Convert and continue."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(first.code, first.stderr + first.stdout).toBe(0);
        expect(first.stderr).toBe("");
        expect(JSON.parse(first.stdout)).toMatchObject({
          session_id: sessionId,
          final_output: "LEGACY_CONVERTED_OK",
        });

        const metadata = JSON.parse(readFileSync(join(sessionDir, "session.json"), "utf8"));
        expect(metadata.schema_version).toBe(4);
        expect(Object.hasOwn(metadata, "history")).toBe(false);
        expect(existsSync(join(sessionDir, "authority.json"))).toBe(false);
        expect(existsSync(join(sessionDir, "checkpoint.json"))).toBe(false);
        expect(existsSync(join(sessionDir, "events.v3.backup"))).toBe(false);

        const second = await runHandwork(
          ["ask", "--json", "--auto", "--resume-id", sessionId, "Continue after restart."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(second.code).toBe(0);
        expect(second.stderr).toBe("");
        expect(JSON.parse(second.stdout)).toMatchObject({
          session_id: sessionId,
          final_output: "LEGACY_RESTART_OK",
        });
        const records = readFileSync(join(sessionDir, "events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const events = records.map((record) => Object.keys(record.event)[0]);
        expect(events).toEqual([
          "context_checkpoint",
          "user",
          "tool_call",
          "tool_result",
          "assistant",
          "turn_completed",
          "user",
          "assistant",
          "turn_completed",
          "user",
          "assistant",
          "turn_completed",
        ]);
        expect(provider.requests).toHaveLength(2);
        for (const request of provider.requests) {
          expect(request.body).toContain(legacySummary);
          expect(request.body).toContain("LEGACY_ORIGINAL_REQUEST");
          expect(request.body).toContain("LEGACY_ORIGINAL_ANSWER");
          expect(request.body).toContain(legacyOutput);
        }
        const preserved = records.find((record) => record.event.tool_result)?.event.tool_result;
        expect(preserved.call_id).toBe("legacy-read");
        expect(preserved.completeness).not.toBe("complete");
        expect(readFileSync(join(sessionDir, "tool-results", preserved.artifact_ref), "utf8")).toBe(legacyOutput);
        const files = records.find((record) => record.event.turn_completed)?.event.turn_completed.files;
        expect(files.map((file: { path: string }) => file.path)).toEqual(["past.txt"]);
      } finally {
        provider.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test(
    "saved asks remain discoverable and resumable without session caches",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-session-cache-free-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const unrelatedReply = `unrelated saved turn ${"x".repeat(64 * 1024)}`;
      const provider = startFakeCodex([
        fakeCodexFinalText(unrelatedReply),
        fakeCodexFinalText("first saved turn"),
        fakeCodexFinalText("second saved turn"),
        fakeCodexFinalText("exact resumed turn"),
        fakeCodexFinalText("latest resumed turn"),
        fakeCodexFinalText("continued target turn"),
        fakeCodexFinalText("continued second turn"),
      ]);
      try {
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        const env = {
          HOME: realpathSync(home),
          HANDWORK_AUTH_MODE: "host-managed",

          HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
          HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
          HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
          HANDWORK_MODEL: FAKE_CODEX_MODEL,
          HANDWORK_AUTO_UPGRADE: "0",
        };

        const unrelated = await runHandwork(
          ["ask", "--json", "--auto", "Save an unrelated long turn."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(unrelated.code).toBe(0);
        expect(unrelated.stderr).toBe("");
        const unrelatedJson = JSON.parse(unrelated.stdout);
        const unrelatedSessionId = unrelatedJson.session_id as string;
        expect(unrelatedJson.output).toBe(unrelatedReply);

        const first = await runHandwork(
          ["ask", "--json", "--auto", "Reply with the first saved turn."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(first.code).toBe(0);
        expect(first.stderr).toBe("");
        const sessionId = JSON.parse(first.stdout).session_id as string;
        const sessionsDir = join(home, ".handwork", "sessions");
        expect(existsSync(join(sessionsDir, "index.json"))).toBe(false);
        expect(existsSync(join(sessionsDir, "latest"))).toBe(false);
        expect(existsSync(join(sessionsDir, "latest.lock"))).toBe(false);

        const createdNext = await runHandwork(
          ["ask", "--json", "--auto", "Create another saved turn."],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(createdNext.code).toBe(0);
        expect(createdNext.stderr).toBe("");
        const createdNextJson = JSON.parse(createdNext.stdout);
        const createdNextId = createdNextJson.session_id as string;
        expect(createdNextJson.output.trim()).toBe("second saved turn");

        const exact = await runHandwork(
          [
            "ask",
            "--json",
            "--auto",
            "--resume-id",
            sessionId,
            "Reply with the exact resumed turn.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(exact.code).toBe(0);
        expect(exact.stderr).toBe("");
        expect(JSON.parse(exact.stdout).output.trim()).toBe("exact resumed turn");

        const listed = await runHandwork(["sessions", "--json"], {
          cwd: workspaceRoot,
          env: { HOME: home, ...NO_PROVIDER_AUTH },
          timeoutMs: 60_000,
        });
        expect(listed.code).toBe(0);
        expect(listed.stderr).toBe("");
        const listedSessions = JSON.parse(listed.stdout).sessions;
        expect(listedSessions[0]).toMatchObject({
          id: sessionId,
          history_len: 2,
        });
        expect(listedSessions[1]).toMatchObject({
          id: createdNextId,
          history_len: 1,
        });
        expect(listedSessions[2]).toMatchObject({
          id: unrelatedSessionId,
          history_len: 1,
        });
        expect(existsSync(join(sessionsDir, "latest"))).toBe(false);

        const latest = await runHandwork(
          [
            "ask",
            "--json",
            "--auto",
            "--resume",
            "last",
            "Reply with the latest resumed turn.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(latest.code).toBe(0);
        expect(latest.stderr).toBe("");
        expect(JSON.parse(latest.stdout).session_id).toBe(sessionId);
        expect(JSON.parse(latest.stdout).output.trim()).toBe("latest resumed turn");

        const repaired = await runHandwork(
          [
            "ask",
            "--json",
            "--auto",
            "--resume-id",
            sessionId,
            "Reply with the continued target turn.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(repaired.code).toBe(0);
        expect(repaired.stderr).toBe("");
        expect(JSON.parse(repaired.stdout).output.trim()).toBe("continued target turn");
        const createdNextDetail = await runHandwork(
          ["session", "--id", createdNextId, "--json"],
          { cwd: workspaceRoot, env: { HOME: home }, timeoutMs: 60_000 },
        );
        expect(createdNextDetail.code).toBe(0);
        expect(createdNextDetail.stderr).toBe("");
        expect(JSON.parse(createdNextDetail.stdout).history_len).toBe(1);
        const continuedNext = await runHandwork(
          [
            "ask",
            "--json",
            "--auto",
            "--resume-id",
            createdNextId,
            "Continue the second saved session.",
          ],
          { cwd: workspaceRoot, env, timeoutMs: 60_000 },
        );
        expect(continuedNext.code).toBe(0);
        expect(continuedNext.stderr).toBe("");
        expect(JSON.parse(continuedNext.stdout).output.trim()).toBe("continued second turn");
        const targetDetail = await runHandwork(
          ["session", "--id", sessionId, "--json"],
          { cwd: workspaceRoot, env: { HOME: home }, timeoutMs: 60_000 },
        );
        expect(targetDetail.code).toBe(0);
        expect(targetDetail.stderr).toBe("");
        expect(JSON.parse(targetDetail.stdout).history_len).toBe(4);
        const unrelatedDetail = await runHandwork(
          ["session", "--id", unrelatedSessionId, "--json"],
          { cwd: workspaceRoot, env: { HOME: home }, timeoutMs: 60_000 },
        );
        expect(unrelatedDetail.code).toBe(0);
        expect(unrelatedDetail.stderr).toBe("");
        expect(JSON.parse(unrelatedDetail.stdout).history_len).toBe(1);
        expect(provider.requests).toHaveLength(7);
      } finally {
        provider.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );

  test.skipIf(!HAS_SUBSCRIPTION)(
    "handwork ask --json --no-save --auto returns valid JSON with output",
    async () => {
      const r = await runHandwork(
        ["ask", "--json", "--no-save", "--auto", "Say exactly: hello world"],
        { timeoutMs: 60_000 },
      );
      expect(r.code).toBe(0);
      const json = JSON.parse(r.stdout.trim());
      expect(typeof json.output).toBe("string");
      expect(json.output.length).toBeGreaterThan(0);
      expect(typeof json.final_output).toBe("string");
      expect(json.final_output.length).toBeGreaterThan(0);
      expect(typeof json.model).toBe("string");
      expect(Array.isArray(json.tool_calls)).toBe(true);
      expect(typeof json.steps).toBe("number");
    },
    60_000,
  );
});

describe("cli: error handling", () => {
  test(
    "handwork ask rejects unknown options before a model turn and -- preserves literal prompt text",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-ask-options-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const provider = startFakeCodex([
        fakeCodexFinalText("literal option prompt complete"),
      ]);
      try {
        mkdirSync(home);
        mkdirSync(workspace);
        const env = {
          HOME: realpathSync(home),
          HANDWORK_AUTH_MODE: "host-managed",

          HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
          HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
          HANDWORK_MODEL: FAKE_CODEX_MODEL,
          HANDWORK_AUTO_UPGRADE: "0",
        };

        const rejected = await runHandwork(["ask", "--definitely-unknown"], {
          cwd: realpathSync(workspace),
          env,
          timeoutMs: TIMEOUT,
        });
        expect(rejected.code).toBe(1);
        expect(rejected.stderr).toContain("usage: handwork ask");
        expect(provider.requests).toHaveLength(0);

        const literal = await runHandwork(
          [
            "ask",
            "--json",
            "--auto",
            "--no-save",
            "--",
            "--definitely-prompt-text",
          ],
          {
            cwd: realpathSync(workspace),
            env,
            timeoutMs: TIMEOUT,
          },
        );
        expect(literal.code).toBe(0);
        const literalJson = JSON.parse(literal.stdout);
        expect(literalJson.output.trim()).toBe(
          "literal option prompt complete",
        );
        expect(literalJson.final_output).toBe("literal option prompt complete");
        expect(provider.requests).toHaveLength(1);
        expect(provider.requests[0]!.body).toContain("--definitely-prompt-text");
      } finally {
        provider.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "handwork ask with no prompt exits 1",
    async () => {
      const r = await runHandwork(["ask"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("missing prompt");
    },
    TIMEOUT,
  );

  test(
    "handwork unknown-command exits 1",
    async () => {
      const r = await runHandwork(["unknown-command"]);
      expect(r.code).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "handwork ask explains no-save resume conflicts before a model turn",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-e2e-ask-resume-no-save-"));
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const provider = startFakeCodex([]);
      try {
        mkdirSync(home);
        mkdirSync(workspace);
        const env = {
          HOME: realpathSync(home),
          HANDWORK_AUTH_MODE: "host-managed",

          HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
          HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
          HANDWORK_MODEL: FAKE_CODEX_MODEL,
          HANDWORK_AUTO_UPGRADE: "0",
        };

        for (const args of [
          ["ask", "--no-save", "--resume", "last", "hello"],
          ["ask", "--resume-id", "session.v3", "--no-save", "hello"],
        ]) {
          const rejected = await runHandwork(args, {
            cwd: realpathSync(workspace),
            env,
            timeoutMs: TIMEOUT,
          });
          expect(rejected.code).toBe(1);
          expect(rejected.stdout).toBe("");
          expect(rejected.stderr).toContain(
            "handwork ask: --no-save cannot be used with --resume or --resume-id",
          );
          expect(rejected.stderr).toContain(
            "usage: handwork ask [--auto|--full-access] [--image PATH] [--system TEXT] [--json] [--quiet] [--prompt-permissions] [--no-save]",
          );
        }
        expect(provider.requests).toHaveLength(0);
      } finally {
        provider.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe("cli: workspace access", () => {
  test(
    "workspace launch modifiers preserve ask help and report friendly option errors",
    async () => {
      const enabled = {
        ...NO_PROVIDER_AUTH,
      };

      const help = await runHandwork(
        ["--add-dir", "/tmp/shared", "ask", "--help"],
        { env: enabled },
      );
      expect(help.code).toBe(0);
      expect(help.stdout.startsWith("handwork ask\n\n")).toBe(true);
      expect(help.stderr).toBe("");

      const missing = await runHandwork(["--add-dir"], { env: enabled });
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("--add-dir requires a directory path");
      expect(missing.stderr).not.toContain("MissingAddDirectoryValue");

      const duplicate = await runHandwork(
        ["--no-additional-dirs", "--no-additional-dirs"],
        { env: enabled },
      );
      expect(duplicate.code).toBe(1);
      expect(duplicate.stderr).toContain(
        "--no-additional-dirs may only be specified once",
      );
      expect(duplicate.stderr).not.toContain(
        "DuplicateAdditionalDirectorySuppression",
      );
    },
    TIMEOUT,
  );

  test(
    "workspace commands persist per-primary roots and track availability",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-workspace-access-cli-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const unknown = join(root, "unknown");
        const missing = join(root, "missing");
        mkdirSync(join(home, ".handwork"), { recursive: true, mode: 0o700 });
        chmodSync(join(home, ".handwork"), 0o700);
        mkdirSync(workspace);
        mkdirSync(shared);
        mkdirSync(unknown);
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const unknownRoot = realpathSync(unknown);
        const baseEnv = {
          ...NO_PROVIDER_AUTH,
          HOME: realpathSync(home),
        };

        const added = await runHandwork(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(added.code).toBe(0);
        const addedJson = JSON.parse(added.stdout.trim());
        expect(addedJson).toMatchObject({
          kind: "workspace",
          action: "add",
          changed: true,
          limit: 16,
          path: sharedRoot,
        });
        expect(addedJson.additional_directories).toEqual([
          {
            path: sharedRoot,
            saved: true,
            command_line: false,
            available: true,
            active: true,
          },
        ]);

        const stored = JSON.parse(
          readFileSync(join(home, ".handwork", "settings.json"), "utf8"),
        );
        expect(stored.workspaces[workspaceRoot].additional_directories).toEqual([
          sharedRoot,
        ]);

        for (const path of [unknownRoot, missing]) {
          const unknownRemoval = await runHandwork(
            ["workspace", "remove", path, "--json"],
            { cwd: workspaceRoot, env: baseEnv },
          );
          expect(unknownRemoval.code).toBe(1);
          expect(JSON.parse(unknownRemoval.stdout.trim())).toEqual({
            kind: "workspace",
            error: "directory is not configured as an additional workspace",
            code: "UnknownAdditionalDirectory",
          });
        }

        const removed = await runHandwork(
          ["workspace", "remove", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removed.code).toBe(0);
        expect(JSON.parse(removed.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          launch_flag_can_restore: false,
          additional_directories: [],
        });

        const readded = await runHandwork(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(readded.code).toBe(0);

        const active = await runHandwork(["workspace", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...baseEnv,
          },
        });
        expect(active.code).toBe(0);
        expect(JSON.parse(active.stdout.trim())).toMatchObject({
          action: "list",
          changed: false,
          additional_directories: [{ path: sharedRoot, active: true }],
        });

        rmSync(sharedRoot, { recursive: true, force: true });
        const unavailable = await runHandwork(["workspace", "list", "--json"], {
          cwd: workspaceRoot,
          env: {
            ...baseEnv,
          },
        });
        expect(unavailable.code).toBe(0);
        expect(JSON.parse(unavailable.stdout.trim()).additional_directories).toEqual([
          {
            path: sharedRoot,
            saved: true,
            command_line: false,
            available: false,
            active: false,
          },
        ]);

        const unavailableRemoved = await runHandwork(
          ["workspace", "remove", `${sharedRoot}${sep}`, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(unavailableRemoved.code).toBe(0);
        expect(JSON.parse(unavailableRemoved.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        const removedSettings = JSON.parse(
          readFileSync(join(home, ".handwork", "settings.json"), "utf8"),
        );
        expect(
          removedSettings.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        mkdirSync(sharedRoot);
        const restored = await runHandwork(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(restored.code).toBe(0);

        const cleared = await runHandwork(["workspace", "clear", "--json"], {
          cwd: workspaceRoot,
          env: baseEnv,
        });
        expect(cleared.code).toBe(0);
        expect(JSON.parse(cleared.stdout.trim())).toMatchObject({
          action: "clear",
          changed: true,
          additional_directories: [],
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test(
    "workspace commands mutate persisted aliases by workspace identity",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-workspace-alias-cli-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        const shared = join(root, "shared");
        const sharedLink = join(root, "shared-link");
        const missing = join(root, "missing");
        const realParent = join(root, "real-parent");
        const parentLink = join(root, "parent-link");
        mkdirSync(join(home, ".handwork"), { recursive: true, mode: 0o700 });
        chmodSync(join(home, ".handwork"), 0o700);
        mkdirSync(workspace);
        mkdirSync(shared);
        mkdirSync(realParent);
        symlinkSync(shared, sharedLink, "dir");
        symlinkSync(realParent, parentLink, "dir");
        const workspaceRoot = realpathSync(workspace);
        const sharedRoot = realpathSync(shared);
        const settingsPath = join(home, ".handwork", "settings.json");
        const baseEnv = {
          ...NO_PROVIDER_AUTH,
          HOME: realpathSync(home),
        };

        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  `${sharedRoot}${sep}.`,
                  sharedLink,
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );

        const unchanged = await runHandwork(
          ["workspace", "add", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(unchanged.code).toBe(0);
        expect(JSON.parse(unchanged.stdout.trim())).toMatchObject({
          action: "add",
          changed: true,
          saved_changed: true,
          runtime_changed: false,
        });

        const removedAvailable = await runHandwork(
          ["workspace", "remove", sharedRoot, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedAvailable.code).toBe(0);
        expect(JSON.parse(removedAvailable.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        let stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [
                  `${missing}${sep}.`,
                  join(missing, "child", ".."),
                ],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const removedUnavailable = await runHandwork(
          ["workspace", "remove", missing, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedUnavailable.code).toBe(0);
        expect(JSON.parse(removedUnavailable.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();

        const realMissing = join(realParent, "missing");
        const linkedMissing = join(parentLink, "missing");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            workspaces: {
              [workspaceRoot]: {
                additional_directories: [realMissing, linkedMissing],
              },
            },
          }) + "\n",
          { mode: 0o600 },
        );
        const removedLinkedPrefix = await runHandwork(
          ["workspace", "remove", linkedMissing, "--json"],
          { cwd: workspaceRoot, env: baseEnv },
        );
        expect(removedLinkedPrefix.code).toBe(0);
        expect(JSON.parse(removedLinkedPrefix.stdout.trim())).toMatchObject({
          action: "remove",
          changed: true,
          additional_directories: [],
        });
        stored = JSON.parse(readFileSync(settingsPath, "utf8"));
        expect(
          stored.workspaces?.[workspaceRoot]?.additional_directories,
        ).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

describe("cli: MCP profile add", () => {
  test("status and doctor inspect MCP without transport while list --connect discovers it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "handwork-cli-mcp-inspect-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const pidPath = join(root, "mcp.pid");
    mkdirSync(join(home, ".handwork"), { recursive: true, mode: 0o700 });
    mkdirSync(workspace);
    writeFileSync(join(home, ".handwork", "settings.json"), "{}\n", { mode: 0o600 });
    writeFileSync(
      join(home, ".handwork", "mcp.json"),
      JSON.stringify({
        mcp: {
          fixture: {
            type: "local",
            command: [process.execPath, MODERN_MCP_FIXTURE],
            environment: { HANDWORK_MCP_PID_PATH: pidPath, HANDWORK_MCP_PROTOCOL_VERSION: "2026-07-28" },
          },
        },
      }),
      { mode: 0o600 },
    );
    const env = { HOME: home, ...NO_PROVIDER_AUTH };
    try {
      const status = await runHandwork(["status", "--json"], { cwd: workspace, env });
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout.trim()).mcp).toMatchObject({
        connection_check: "not_checked",
        servers: [{
          name: "fixture",
          source: "profile",
          connection: "not_checked",
          authentication: "not_checked",
        }],
      });
      expect(existsSync(pidPath)).toBe(false);

      const doctor = await runHandwork(["doctor", "--json"], { cwd: workspace, env });
      expect(doctor.code).toBe(0);
      expect(JSON.parse(doctor.stdout.trim()).mcp.connection_check).toBe(
        "not_checked",
      );
      expect(existsSync(pidPath)).toBe(false);

      const passive = await runHandwork(["mcp", "list"], { cwd: workspace, env });
      expect(passive.code).toBe(0);
      expect(passive.stdout).toContain("state=disconnected");
      expect(existsSync(pidPath)).toBe(false);

      const connected = await runHandwork(
        ["mcp", "list", "--connect"],
        { cwd: workspace, env, timeoutMs: TIMEOUT },
      );
      expect(connected.code).toBe(0);
      expect(connected.stderr).toBe("");
      expect(connected.stdout).toContain("state=ready");
      expect(connected.stdout).toContain("tools=1");
      expect(existsSync(pidPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("lists paths and removes profile servers without launching MCP transport", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "handwork-cli-mcp-manage-")));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const profileMarker = join(root, "profile-launched");
    const workspaceMarker = join(root, "workspace-launched");
    mkdirSync(join(home, ".handwork"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(home, ".handwork", "settings.json"), JSON.stringify({}));
    writeFileSync(
      join(home, ".handwork", "mcp.json"),
      JSON.stringify({
        mcp: {
          shared: {
            command: ["/bin/sh", "-c", `touch ${profileMarker}`],
          },
        },
      }),
    );
    writeFileSync(
      join(workspace, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: {
            command: "/bin/sh",
            args: ["-c", `touch ${workspaceMarker}`],
          },
          "workspace-only": {
            command: "/bin/sh",
            args: ["-c", `touch ${workspaceMarker}`],
          },
          broken: {
            command: "${MISSING_LIST_COMMAND}",
          },
        },
      }),
    );
    const env = { HOME: home, ...NO_PROVIDER_AUTH };
    try {
      const path = await runHandwork(["mcp", "path"], { cwd: workspace, env });
      expect(path.code).toBe(0);
      expect(path.stderr).toBe("");
      expect(path.stdout.trim()).toBe(join(home, ".handwork", "mcp.json"));

      const before = await runHandwork(["mcp", "list"], { cwd: workspace, env });
      expect(before.code).toBe(0);
      expect(before.stderr).toBe("");
      expect(before.stdout).toMatch(/shared source=profile scope=profile/);
      expect(before.stdout).toMatch(
        /workspace-only source=workspace scope=workspace/,
      );
      expect(before.stdout).not.toMatch(/shared source=workspace scope=workspace/);
      expect(before.stdout).not.toContain("MISSING_LIST_COMMAND");
      expect(existsSync(profileMarker)).toBe(false);
      expect(existsSync(workspaceMarker)).toBe(false);

      const removed = await runHandwork(["mcp", "remove", "shared"], {
        cwd: workspace,
        env,
      });
      expect(removed.code).toBe(0);
      expect(removed.stderr).toBe("");
      expect(removed.stdout).toContain("Removed MCP server 'shared'");
      expect(JSON.parse(readFileSync(join(home, ".handwork", "mcp.json"), "utf8")))
        .toEqual({ mcp: {} });

      const after = await runHandwork(["mcp", "list"], { cwd: workspace, env });
      expect(after.code).toBe(0);
      expect(after.stdout).toMatch(/shared source=workspace scope=workspace/);
      expect(existsSync(profileMarker)).toBe(false);
      expect(existsSync(workspaceMarker)).toBe(false);

      const missing = await runHandwork(["mcp", "remove", "missing"], {
        cwd: workspace,
        env,
      });
      expect(missing.code).not.toBe(0);
      expect(missing.stderr).toContain("MCP server 'missing' was not found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("adds local and HTTP servers without launching either server", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "handwork-cli-mcp-add-")));
    const home = join(root, "home");
    const marker = join(root, "launched");
    mkdirSync(home, { recursive: true });
    try {
      const help = await runHandwork(["mcp", "--help"], {
        env: { HOME: home, ...NO_PROVIDER_AUTH },
      });
      expect(help.code).toBe(0);
      for (const command of [
        "handwork mcp add NAME COMMAND [ARGS...]",
        "handwork mcp auth NAME",
        "handwork mcp list",
        "handwork mcp logout NAME",
        "handwork mcp path",
        "handwork mcp remove NAME",
        "handwork mcp trust approve|reject NAME",
        "handwork mcp trust approve-all|reset",
      ]) expect(help.stdout).toContain(command);

      const local = await runHandwork(
        ["mcp", "add", "local", "/bin/sh", "-c", `touch ${marker}`],
        { env: { HOME: home, ...NO_PROVIDER_AUTH } },
      );
      const bare = await runHandwork(["mcp"], { env: { HOME: home, ...NO_PROVIDER_AUTH } });
      expect(bare.code).toBe(0);
      expect(bare.stdout).toBe(help.stdout);
      expect(existsSync(marker)).toBe(false);
      const missingAuthName = await runHandwork(["mcp", "auth"], {
        env: { HOME: home, ...NO_PROVIDER_AUTH },
      });
      expect(missingAuthName.code).toBe(1);
      expect(missingAuthName.stderr).toBe("usage: handwork mcp auth NAME\n");
      expect(existsSync(marker)).toBe(false);
      expect(local.code).toBe(0);
      expect(local.stderr).toBe("");
      expect(local.stdout).toContain("Saved MCP server 'local'");
      expect(existsSync(marker)).toBe(false);

      const remote = await runHandwork(
        [
          "mcp",
          "add",
          "--transport",
          "http",
          "remote",
          "https://example.test/mcp",
        ],
        { env: { HOME: home, ...NO_PROVIDER_AUTH } },
      );
      expect(remote.code).toBe(0);
      expect(remote.stderr).toBe("");

      const profile = JSON.parse(
        readFileSync(join(home, ".handwork", "mcp.json"), "utf8"),
      );
      expect(profile).not.toHaveProperty("mcpServers");
      expect(profile.mcp.local.command).toEqual([
        "/bin/sh",
        "-c",
        `touch ${marker}`,
      ]);
      expect(profile.mcp.remote).toMatchObject({
        type: "http",
        url: "https://example.test/mcp",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonicalizes alias input and refuses ambiguous server-like keys", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "handwork-cli-mcp-alias-")));
    const home = join(root, "home");
    const handworkDir = join(home, ".handwork");
    mkdirSync(handworkDir, { recursive: true, mode: 0o700 });
    const profilePath = join(handworkDir, "mcp.json");
    try {
      writeFileSync(
        profilePath,
        JSON.stringify({ mcpServers: { old: { command: "old-server" } } }),
        { mode: 0o600 },
      );
      const migrated = await runHandwork(
        ["mcp", "add", "new", "new-server"],
        { env: { HOME: home, ...NO_PROVIDER_AUTH } },
      );
      expect(migrated.code).toBe(0);
      const canonical = JSON.parse(readFileSync(profilePath, "utf8"));
      expect(Object.keys(canonical.mcp).sort()).toEqual(["new", "old"]);
      expect(canonical).not.toHaveProperty("mcpServers");

      const ambiguous = JSON.stringify({
        mcp: { canonical: { command: "canonical-server" } },
        "MCP-Servers": { blocked: { command: "blocked-server" } },
        metadata: { owner: "team" },
      });
      writeFileSync(profilePath, ambiguous, { mode: 0o600 });
      const refused = await runHandwork(
        ["mcp", "add", "unsafe", "must-not-save"],
        { env: { HOME: home, ...NO_PROVIDER_AUTH } },
      );
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("McpConfigAmbiguousServerKey");
      expect(readFileSync(profilePath, "utf8")).toBe(ambiguous);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes concurrent different-name additions", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "handwork-cli-mcp-race-")));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    try {
      const [first, second] = await Promise.all([
        runHandwork(["mcp", "add", "first", "first-server"], {
          env: { HOME: home, ...NO_PROVIDER_AUTH },
        }),
        runHandwork(["mcp", "add", "second", "second-server"], {
          env: { HOME: home, ...NO_PROVIDER_AUTH },
        }),
      ]);
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const profile = JSON.parse(
        readFileSync(join(home, ".handwork", "mcp.json"), "utf8"),
      );
      expect(Object.keys(profile.mcp).sort()).toEqual(["first", "second"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails precisely without HOME or valid add syntax", async () => {
    const missingHome = await runHandwork(["mcp", "add", "fixture", "node"], {
      env: { HOME: undefined, ...NO_PROVIDER_AUTH },
    });
    expect(missingHome.code).not.toBe(0);
    expect(missingHome.stderr).toContain("HomeNotSet");

    const invalid = await runHandwork(
      ["mcp", "add", "--transport", "sse", "fixture", "https://example.test"],
      { env: { HOME: tmpdir(), ...NO_PROVIDER_AUTH } },
    );
    expect(invalid.code).not.toBe(0);
    expect(invalid.stderr).toContain("mcp add NAME COMMAND");
  });
});
