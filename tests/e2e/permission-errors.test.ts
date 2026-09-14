import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDWORK_BIN, runHandwork } from "../evals/eval-helpers";
import {
  FAKE_CODEX_MODEL,
  fakeCodexFinalText,
  fakeCodexPermissionDecision,
  fakeShellRun,
  startFakeCodex,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 120_000;

type HandworkJson = {
  output: string;
  exit_code: number;
  tool_calls: Array<{ name: string; status: string }>;
};

type PermissionEcho = {
  type: string;
  tool_name: string;
  message: string;
  reason: string;
  denied: boolean;
};

function createIsolatedRoot(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(home, ".handwork"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { root, home, workspace };
}

function parseHandworkJson(result: { stdout: string; stderr: string; code: number | null }): HandworkJson {
  if (result.code !== 0) {
    throw new Error(`handwork exited ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim()) as HandworkJson;
}

function executionDeniedReason(body: string, toolCallId: string): string {
  const request = JSON.parse(body) as {
    prompt?: Array<{ content?: Array<Record<string, unknown>> }>;
  };
  const result = (request.prompt ?? [])
    .flatMap((message) => message.content ?? [])
    .find((part) => part.type === "tool-result" && part.toolCallId === toolCallId);
  expect(result).toBeDefined();
  const output = result!.output as Record<string, unknown>;
  expect(output.type).toBe("execution-denied");
  expect(typeof output.reason).toBe("string");
  expect(output.value).toBeUndefined();
  return output.reason as string;
}

function permissionEnv(
  home: string,
  provider: ReturnType<typeof startFakeCodex>,
) {
  return {
    HOME: home,
    HANDWORK_AUTH_MODE: "host-managed",

    HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
    HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
    HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
    HANDWORK_MODEL: FAKE_CODEX_MODEL,
    HANDWORK_AUTO_UPGRADE: "0",
    NO_COLOR: "1",
  };
}

async function waitForPaneExit(
  session: TmuxSession,
  expectedStatus: number,
) {
  const deadline = Date.now() + TIMEOUT;
  while (Date.now() < deadline) {
    const status = session.paneStatus();
    if (status.dead) {
      expect(status.status).toBe(expectedStatus);
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(
    `Timed out waiting for handwork ask to exit.\n${await session.captureFullScrollback()}`,
  );
}

async function runTtyPromptPermissionsCase(
  outputMode: "json" | "quiet",
  decision: "approve" | "deny",
) {
  const root = createIsolatedRoot(
    `handwork-${outputMode}-prompt-permissions-${decision}-`,
  );
  const marker = join(root.workspace, `${decision}-marker.txt`);
  const stdoutPath = join(root.root, `${decision}.stdout`);
  writeFileSync(
    join(root.home, ".handwork", "settings.json"),
    JSON.stringify({ permission_mode: "ask", sandbox: "none" }),
  );
  writeFileSync(stdoutPath, "");
  const provider = startFakeCodex([
    fakeShellRun(`${decision}_${outputMode}_call`, `touch ${JSON.stringify(marker)}`, {
      timeout_ms: 600_000,
    }),
    fakeCodexFinalText(`${decision} ${outputMode} complete`),
  ]);
  let session: TmuxSession | null = null;
  try {
    session = await TmuxSession.create({
      cmd: `${JSON.stringify(HANDWORK_BIN)} ask --${outputMode} --prompt-permissions --no-save "Run the exact ${outputMode} fixture." > ${JSON.stringify(stdoutPath)}`,
      cwd: root.workspace,
      env: permissionEnv(root.home, provider),
      remainOnExit: true,
    });
    const prompt = await session.waitForText("Approve? [y/N]", TIMEOUT);
    expect(prompt).toContain("handwork wants to run:");
    expect(existsSync(marker)).toBe(false);
    await session.sendText(decision === "approve" ? "y" : "n");
    await waitForPaneExit(session, 0);

    const stdout = readFileSync(stdoutPath, "utf8");
    expect(stdout).not.toContain("Approve? [y/N]");
    if (outputMode === "json") {
      const json = JSON.parse(stdout) as HandworkJson;
      expect(json.exit_code).toBe(0);
      expect(json.tool_calls).toContainEqual(
        expect.objectContaining({
          name: "shell",
          status: decision === "approve" ? "success" : "error",
        }),
      );
    } else {
      expect(stdout).toBe("");
    }
    expect(existsSync(marker)).toBe(decision === "approve");
    expect(provider.requests).toHaveLength(2);
  } finally {
    if (session) await session.kill();
    provider.stop();
    rmSync(root.root, { recursive: true, force: true });
  }
}

describe("generic permission typed errors", () => {
  test(
    "returns typed JSON for denied terminal",
    async () => {
      const root = createIsolatedRoot("handwork-permission-error-");
      const marker = join(root.workspace, "denied-marker.txt");
      const toolCallId = "permission_denied_call";
      const provider = startFakeCodex([
        fakeShellRun(toolCallId, `touch ${JSON.stringify(marker)}`, {
          timeout_ms: 600_000,
        }),
        fakeCodexFinalText("permission error observed"),
      ]);
      try {
        writeFileSync(
          join(root.home, ".handwork", "settings.json"),
          JSON.stringify({
            workspaces: {
              [root.workspace]: {
                permission: {
                  bash: {
                    "touch *denied-marker.txt*": "deny",
                  },
                },
              },
            },
          }),
        );

        const result = await runHandwork(["ask", "--json", "--no-save", "--auto", "Run the denied command."], {
          cwd: root.workspace,
          env: {
            HOME: root.home,
            HANDWORK_AUTH_MODE: "host-managed",

            HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
            HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
            HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
            HANDWORK_MODEL: FAKE_CODEX_MODEL,
            HANDWORK_AUTO_UPGRADE: "0",
          },
          timeoutMs: TIMEOUT,
        });
        const json = parseHandworkJson(result);
        expect(result.stderr).toBe('Running touch "./denied-marker.txt"\n');
        expect(json.tool_calls).toContainEqual({
          name: "shell",
          status: "error",
          action: "run",
          error: {
            category: "rejected",
            code: "rejected",
          },
        });
        expect(existsSync(marker)).toBe(false);
        expect(provider.requests).toHaveLength(2);

        const toolResult = JSON.parse(
          executionDeniedReason(provider.requests[1]!.body, toolCallId),
        ) as { error: PermissionEcho };
        const echo = toolResult.error;
        expect(echo.type).toBe("tool_permission_denied");
        expect(echo.tool_name).toBe("shell");
        expect(echo.message).toBe("Tool access was denied by configured policy");
        expect(echo.reason).toBe("policy_denied");
        expect(echo.denied).toBe(true);
      } finally {
        provider.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "JSON prompt-permissions approval and denial preserve stdout and exact execution",
    async () => {
      for (const decision of ["approve", "deny"] as const) {
        await runTtyPromptPermissionsCase("json", decision);
      }
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "JSON prompt-permissions does not prompt after repeated advisory cautions",
    async () => {
      const root = createIsolatedRoot("handwork-json-auto-prompt-permissions-");
      const markers = Array.from(
        { length: 4 },
        (_, index) => join(root.workspace, `auto-marker-${index + 1}.txt`),
      );
      const stdoutPath = join(root.root, "auto.stdout");
      writeFileSync(
        join(root.home, ".handwork", "settings.json"),
        JSON.stringify({ permission_mode: "auto", sandbox: "none" }),
      );
      writeFileSync(stdoutPath, "");
      const provider = startFakeCodex(
        [
          ...markers.map((marker, index) => (body?: string) => {
            if (index > 0) expect(body).toContain("review_caution");
            return fakeShellRun(
              `auto_call_${index + 1}`,
              `touch ${JSON.stringify(marker)}`,
              { timeout_ms: 600_000 },
            );
          }),
          fakeCodexFinalText("Advisory cautions handled normally."),
        ],
        {
          classifierResponses: Array.from(
            { length: 4 },
            (_, index) => fakeCodexPermissionDecision(
              "caution",
              `auto_review_${index + 1}`,
            ),
          ),
        },
      );
      let session: TmuxSession | null = null;
      try {
        session = await TmuxSession.create({
          cmd: `${JSON.stringify(HANDWORK_BIN)} ask --auto --json --prompt-permissions --no-save "Run the advisory caution fixture." > ${JSON.stringify(stdoutPath)}`,
          cwd: root.workspace,
          env: permissionEnv(root.home, provider),
          remainOnExit: true,
        });
        await waitForPaneExit(session, 0);
        const scrollback = await session.captureFullScrollback();
        expect(scrollback).not.toContain("Approve? [y/N]");
        for (const marker of markers) expect(existsSync(marker)).toBe(false);
        expect(provider.classifierRequests).toHaveLength(4);

        const stdout = readFileSync(stdoutPath, "utf8");
        expect(stdout).not.toContain("Approve? [y/N]");
        const json = JSON.parse(stdout) as HandworkJson;
        expect(json.output).toContain("Advisory cautions handled normally.");
        expect(json.tool_calls.filter((call) => call.status === "error")).toHaveLength(4);
        expect(json.tool_calls.filter((call) => call.status === "success")).toHaveLength(0);
        expect(provider.requests).toHaveLength(5);
        expect(provider.classifierRequests).toHaveLength(4);
      } finally {
        if (session) await session.kill();
        provider.stop();
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "quiet prompt-permissions approval and denial keep stdout empty",
    async () => {
      for (const decision of ["approve", "deny"] as const) {
        await runTtyPromptPermissionsCase("quiet", decision);
      }
    },
    TIMEOUT,
  );

  test(
    "JSON and quiet permission prompting remain fail-closed without a TTY or explicit opt in",
    async () => {
      const cases = [
        { mode: "json", args: ["--json"], optIn: false },
        { mode: "json", args: ["--json", "--prompt-permissions"], optIn: true },
        { mode: "quiet", args: ["--quiet"], optIn: false },
        { mode: "quiet", args: ["--quiet", "--prompt-permissions"], optIn: true },
      ] as const;

      for (const testCase of cases) {
        const root = createIsolatedRoot(
          `handwork-${testCase.mode}-${testCase.optIn ? "opt-in" : "default"}-non-tty-`,
        );
        const marker = join(root.workspace, "must-not-run.txt");
        writeFileSync(
          join(root.home, ".handwork", "settings.json"),
          JSON.stringify({ permission_mode: "ask", sandbox: "none" }),
        );
        const provider = startFakeCodex([
          fakeShellRun("non_tty_call", `touch ${JSON.stringify(marker)}`, {
            timeout_ms: 600_000,
          }),
        ]);
        try {
          const result = await runHandwork(
            [
              "ask",
              ...testCase.args,
              "--no-save",
              "Run the non-TTY fixture.",
            ],
            {
              cwd: root.workspace,
              env: permissionEnv(root.home, provider),
              timeoutMs: TIMEOUT,
            },
          );

          expect(result.timedOut).toBe(false);
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("noninteractive_permission_prompt_unavailable");
          expect(result.stderr).not.toContain("Approve? [y/N]");
          if (testCase.mode === "json") {
            const json = JSON.parse(result.stdout) as HandworkJson & {
              error: string;
            };
            expect(json.error).toBe("NonInteractivePermissionRequired");
          } else {
            expect(result.stdout).toBe("");
          }
          expect(provider.requests).toHaveLength(1);
          expect(existsSync(marker)).toBe(false);
        } finally {
          provider.stop();
          rmSync(root.root, { recursive: true, force: true });
        }
      }
    },
    TIMEOUT,
  );
});
