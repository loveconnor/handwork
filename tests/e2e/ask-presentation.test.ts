import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { HANDWORK_BIN, runHandwork } from "../evals/eval-helpers";
import {
  FAKE_CODEX_MODEL,
  fakeCodexFinalText,
  fakeCodexPermissionDecision,
  fakeCodexSse,
  fakeCodexSerializedToolCall,
  fakeCodexToolCall,
  fakeShellRun,
  startDynamicFakeCodex,
  startFakeCodex,
  terminalFixtureShell,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 30_000;
const TERMINAL_FIXTURE_SHELL = terminalFixtureShell();
const MARKDOWN =
  "# Ask presentation\n\n" +
  "**bold** and [docs](https://example.com)\n\n" +
  "- first item\n- second item\n\n---\n\n" +
  "| Name | Value |\n| --- | --- |\n| one | two |\n\n" +
  "```zig\nconst answer: u8 = 42;\n```\n";

const roots: string[] = [];
const providers: Array<{ stop(): void }> = [];
const sessions: TmuxSession[] = [];

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.kill();
  for (const provider of providers.splice(0)) provider.stop();
  await Promise.all(roots.map(waitForTerminalHostExit));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitForTerminalHostExit(root: string): Promise<void> {
  const identityPath = join(root, "home", ".handwork", "terminal-host-v7", "host.json");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!existsSync(identityPath)) return;
    await Bun.sleep(25);
  }
  throw new Error(`terminal host did not exit for ${root}`);
}

function createRoot() {
  const root = mkdtempSync(join(tmpdir(), "handwork-e2e-ask-presentation-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  roots.push(root);
  return { root, home: realpathSync(home), workspace: realpathSync(workspace) };
}

function createShortRoot() {
  const root = realpathSync(mkdtempSync("/tmp/handwork-ask-terminal-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  roots.push(root);
  return { root, home: realpathSync(home), workspace: realpathSync(workspace) };
}

function providerEnv(
  home: string,
  provider: ReturnType<typeof startFakeCodex>,
): Record<string, string | undefined> {
  return {
    HOME: home,
    HANDWORK_AUTH_MODE: "host-managed",

    HANDWORK_DISABLE_KEYCHAIN: "1",
    HANDWORK_SKIP_ONBOARDING: "1",
    HANDWORK_MODEL: FAKE_CODEX_MODEL,
    HANDWORK_PERMISSION_MODE: "auto",
    HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
    HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
    HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function terminalCommand(args: string[]): string {
  const handwork = [HANDWORK_BIN, ...args].map(shellQuote).join(" ");
  const script = `${handwork}; code=$?; printf '\\n__HANDWORK_EXIT_%s__\\n' "$code"; exit "$code"`;
  return `/bin/sh -c ${shellQuote(script)}`;
}

function fakeCodexStreamingText(lines: string[], delayMs: number) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ type: "response.output_text.delta", delta: `${line}\n` })}\n\n`,
          ));
          if (delayMs > 0) await Bun.sleep(delayMs);
        }
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: ({
              inputTokens: { total: 3 },
              outputTokens: { total: lines.length },
            }).inputTokens?.total ?? 0, output_tokens: ({
              inputTokens: { total: 3 },
              outputTokens: { total: lines.length },
            }).outputTokens?.total ?? 0 } } })}\n\ndata: [DONE]\n\n`,
        ));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

describe("handwork ask presentation", () => {
  test("redirected command output separates the next tool header", async () => {
    const root = createRoot();
    const provider = startFakeCodex([
      fakeCodexSse([
        { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "no-final-newline", name: "shell", arguments: JSON.stringify({ request: { action: "run", profile: "clean", yield_time_ms: 30_000, command: "printf no-final-newline" } }) } },
        { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "next-command", name: "shell", arguments: JSON.stringify({ request: { action: "run", profile: "clean", yield_time_ms: 30_000, command: "printf 'next-output\\n'" } }) } },
        { type: "response.completed", response: { status: "completed", usage: { input_tokens: ({}).inputTokens?.total ?? 0, output_tokens: ({}).outputTokens?.total ?? 0 } } },
      ]),
      fakeCodexFinalText("Commands complete.\n"),
    ]);
    providers.push(provider);

    const result = await runHandwork(
      ["ask", "--json", "--yolo", "--no-save", "--no-color", "Run both commands."],
      {
        cwd: root.workspace,
        env: providerEnv(root.home, provider),
        timeoutMs: TIMEOUT,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Running printf no-final-newline\n");
    expect(result.stderr).toContain("Running printf 'next-output\\n'\n");
    expect(JSON.parse(result.stdout).output).toBe("Commands complete.\n");
  }, TIMEOUT);

  test("no-save advertises process-local shell actions and preserves run profiles", async () => {
    const configuredShell = userInfo().shell;
    if (!configuredShell.endsWith("/bash") && !configuredShell.endsWith("/zsh")) return;

    const root = createRoot();
    if (configuredShell.endsWith("/zsh")) {
      writeFileSync(
        join(root.home, ".zprofile"),
        "export HANDWORK_PROFILE_LOGIN=login\nexport PATH=\"$HOME/profile-bin:$PATH\"\n",
      );
      writeFileSync(
        join(root.home, ".zshrc"),
        "export HANDWORK_PROFILE_RC=rc\nalias handwork_profile_alias='printf alias-user'\n" +
          "handwork_profile_function() { printf function-user; }\n",
      );
    } else {
      writeFileSync(
        join(root.home, ".bash_profile"),
        "export HANDWORK_PROFILE_LOGIN=login\nexport PATH=\"$HOME/profile-bin:$PATH\"\n" +
          "source \"$HOME/.bashrc\"\n",
      );
      writeFileSync(
        join(root.home, ".bashrc"),
        "export HANDWORK_PROFILE_RC=rc\nalias handwork_profile_alias='printf alias-user'\n" +
          "handwork_profile_function() { printf function-user; }\n",
      );
    }

    const profileCommand =
      "printf 'mode=%s:%s:' \"${HANDWORK_PROFILE_LOGIN-unset}\" \"${HANDWORK_PROFILE_RC-unset}\"; " +
      "case :\"$PATH\": in *:\"$HOME/profile-bin\":*) printf 'path-user:';; *) printf 'path-clean:';; esac; " +
      "if alias handwork_profile_alias >/dev/null 2>&1; then handwork_profile_alias; else printf no-alias; fi; printf ':'; " +
      "if command -v handwork_profile_function >/dev/null; then handwork_profile_function; else printf no-function; fi";
    const nestedExecMarker = join(root.workspace, "nested-no-save-ran");
    const provider = startFakeCodex([
      fakeCodexToolCall("shell-omitted", "shell", {
        request: { action: "run", command: profileCommand, yield_time_ms: 30_000 },
      }),
      fakeCodexToolCall("shell-clean", "shell", {
        request: { action: "run", command: profileCommand, profile: "clean", yield_time_ms: 30_000 },
      }),
      fakeCodexToolCall("shell-user", "shell", {
        request: { action: "run", command: profileCommand, profile: "user", yield_time_ms: 30_000 },
      }),
      fakeCodexToolCall("shell-stale-tty", "shell", {
        request: {
          action: "run",
          command: "printf should-not-start",
          tty: true,
        },
      }),
      fakeCodexToolCall("shell-nested-run", "shell", {
        request: {
          action: "run",
          profile: "clean",
          yield_time_ms: 30_000,
          command: `printf nested > ${JSON.stringify(nestedExecMarker)}`,
        },
      }),
      fakeCodexToolCall("shell-neighbor-run", "shell", {
        request: { action: "run", profile: "clean", yield_time_ms: 30_000, command: "printf neighbor-exec" },
      }),
      fakeCodexFinalText("Shell no-save profiles verified.\n"),
    ]);
    providers.push(provider);

    const result = await runHandwork(
      ["ask", "--json", "--yolo", "--no-save", "Verify shell run profiles."],
      {
        cwd: root.workspace,
        env: providerEnv(root.home, provider),
        timeoutMs: TIMEOUT,
      },
    );

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      output: string;
      tool_calls: Array<{ name: string; status: string }>;
    };
    expect(output.output).toBe("Shell no-save profiles verified.\n");
    expect(output.tool_calls.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: "shell", status: "success" },
      { name: "shell", status: "success" },
      { name: "shell", status: "success" },
      { name: "shell", status: "error" },
      { name: "shell", status: "success" },
      { name: "shell", status: "success" },
    ]);
    expect(provider.requests).toHaveLength(7);

    const firstRequest = JSON.parse(provider.requests[0]!.body) as {
      tools: Array<any>;
    };
    const shellTool = firstRequest.tools.find(({ name }) => name === "shell");
    const shellSchema = shellTool?.inputSchema;
    expect(Object.keys(shellSchema?.properties ?? {})).toEqual(["request"]);
    expect(shellSchema?.required).toEqual(["request"]);
    expect(shellSchema?.additionalProperties).toBe(false);
    const branches = shellSchema?.properties?.request?.oneOf ?? [];
    expect(branches.map((branch: any) => branch.properties.action.enum[0])).toEqual([
      "run",
      "interact",
      "stop",
    ]);
    const serializedShellTool = JSON.stringify(shellTool);
    expect(serializedShellTool).not.toContain('"tty"');
    expect(serializedShellTool).not.toContain('"write"');
    expect(serializedShellTool).not.toContain('"terminal"');

    for (const requestIndex of [1, 3]) {
      expect(provider.requests[requestIndex]!.body).toContain("mode=login:rc:path-user:");
      expect(provider.requests[requestIndex]!.body).toContain("alias-user:function-user");
    }
    expect(provider.requests[2]!.body).toContain("mode=unset:unset:path-clean:");
    expect(provider.requests[2]!.body).toContain("no-alias:no-function");
    expect(provider.requests[4]!.body).toContain("tool_execution_failed");
    expect(provider.requests[4]!.body).toContain("tool_execution_failed");
    expect(provider.requests[4]!.body).not.toContain("authority_denied");
    expect(provider.requests[4]!.body).not.toContain("tool_permission_denied");
    expect(provider.requests[5]!.body).toContain("nested");
    expect(existsSync(nestedExecMarker)).toBe(true);
    expect(provider.requests[6]!.body).toContain("neighbor-exec");
    expect(
      existsSync(join(root.home, ".handwork", "terminal-host-v7", "host.json")),
    ).toBe(false);
  }, TIMEOUT);

  test("redirected and JSON stdout preserve raw assistant Markdown", async () => {
    const root = createRoot();
    const rawProvider = startFakeCodex([fakeCodexFinalText(MARKDOWN)]);
    providers.push(rawProvider);
    const raw = await runHandwork(["ask", "--no-save", "Render the fixture."], {
      cwd: root.workspace,
      env: providerEnv(root.home, rawProvider),
      timeoutMs: TIMEOUT,
    });

    expect(raw.code).toBe(0);
    expect(raw.stdout).toBe(MARKDOWN);
    expect(raw.stdout).not.toContain("\x1b");
    expect(raw.stderr).toBe("");

    const jsonProvider = startFakeCodex([fakeCodexFinalText(MARKDOWN)]);
    providers.push(jsonProvider);
    const json = await runHandwork(
      ["ask", "--json", "--no-save", "Render the fixture."],
      {
        cwd: root.workspace,
        env: providerEnv(root.home, jsonProvider),
        timeoutMs: TIMEOUT,
      },
    );

    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).output).toBe(MARKDOWN);
    expect(json.stdout).not.toContain("\x1b");
    expect(json.stderr).toBe("");
  }, TIMEOUT);

  test("JSON separates accumulated assistant Markdown from the completed final response", async () => {
    const root = createRoot();
    writeFileSync(join(root.workspace, "fixture.txt"), "fixture contents\n");
    const intermediate = "I will inspect the fixture first.\n";
    const final = "The fixture inspection is complete.";
    const provider = startFakeCodex([
      fakeCodexSerializedToolCall(
        "read_fixture_for_final_output",
        "read_file",
        JSON.stringify({ path: "fixture.txt" }),
        intermediate,
      ),
      fakeCodexFinalText(final),
    ]);
    providers.push(provider);

    const result = await runHandwork(
      ["ask", "--json", "--auto", "--no-save", "Inspect fixture.txt."],
      {
        cwd: root.workspace,
        env: providerEnv(root.home, provider),
        timeoutMs: TIMEOUT,
      },
    );

    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout) as {
      output: string;
      final_output: string;
      tool_calls: Array<{ name: string; status: string }>;
    };
    expect(output.output).toContain(intermediate.trim());
    expect(output.output).toContain(final.trim());
    expect(output.output.indexOf(intermediate.trim())).toBeLessThan(
      output.output.indexOf(final.trim()),
    );
    expect(output.final_output).toBe(final);
    expect(output.final_output).not.toContain(intermediate.trim());
    expect(output.tool_calls).toEqual([
      { name: "read_file", status: "success" },
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(result.stderr).toContain("Reading fixture.txt");
  }, TIMEOUT);

  test("tool recovery keeps progress updates ordered before the final response", async () => {
    const root = createRoot();
    writeFileSync(join(root.workspace, "fallback.txt"), "fallback contents\n");
    const initial = "I will inspect the requested file first.";
    const recovery = "The requested file was missing, so I will inspect fallback.txt next.";
    const final = "The fallback inspection is complete.";
    const provider = startFakeCodex([
      fakeCodexSerializedToolCall(
        "read_missing_for_progress",
        "read_file",
        JSON.stringify({ path: "missing.txt" }),
        initial,
      ),
      fakeCodexSerializedToolCall(
        "read_fallback_for_progress",
        "read_file",
        JSON.stringify({ path: "fallback.txt" }),
        recovery,
      ),
      fakeCodexFinalText(final),
    ]);
    providers.push(provider);

    const result = await runHandwork(
      ["ask", "--json", "--auto", "--no-save", "Inspect missing.txt and recover with fallback.txt."],
      {
        cwd: root.workspace,
        env: providerEnv(root.home, provider),
        timeoutMs: TIMEOUT,
      },
    );

    expect(result.code).toBe(0);
    expect(provider.requests).toHaveLength(3);
    const firstPrompt = (JSON.parse(provider.requests[0]!.body) as ProviderRequestBody)
      .prompt
      .filter((message) => message.role === "system")
      .map((message) => typeof message.content === "string" ? message.content : "")
      .join("\n");
    expect(firstPrompt).toContain(
      "Before the first tool call in a tool-driven task, always send one brief user-visible update",
    );
    expect(firstPrompt).toContain("Never start the first tool silently.");
    expect(firstPrompt).toContain(
      "If another tool call will follow, always first tell the user what failed",
    );
    expect(firstPrompt).toContain("Do not narrate each routine tool call.");

    const output = JSON.parse(result.stdout) as {
      output: string;
      final_output: string;
      tool_calls: Array<{ name: string; status: string }>;
    };
    expect(output.output).toContain(initial);
    expect(output.output).toContain(recovery);
    expect(output.output).toContain(final);
    expect(output.output.indexOf(initial)).toBeLessThan(
      output.output.indexOf(recovery),
    );
    expect(output.output.indexOf(recovery)).toBeLessThan(
      output.output.indexOf(final),
    );
    expect(output.final_output).toBe(final);
    expect(output.tool_calls).toEqual([
      { name: "read_file", status: "error" },
      { name: "read_file", status: "success" },
    ]);
    expect(provider.requests[1]!.body).toContain("FileNotFound");
    expect(provider.requests[2]!.body).toContain(recovery);
    expect(result.stderr).toContain("Reading missing.txt");
    expect(result.stderr).toContain("Reading fallback.txt");
  }, TIMEOUT);

  test.skipIf(!tmuxAvailable())(
    "TTY stdout uses the Minimal transcript and compact tool group",
    async () => {
      const root = createRoot();
      writeFileSync(join(root.workspace, "fixture.txt"), "fixture contents\n");
      let releaseFinal: (() => void) | undefined;
      const finalReady = new Promise<void>((resolve) => {
        releaseFinal = resolve;
      });
      const provider = startFakeCodex([
        fakeCodexToolCall("read_fixture", "read_file", { path: "fixture.txt" }),
        fakeCodexSerializedToolCall(
          "read_missing",
          "read_file",
          JSON.stringify({ path: "missing.txt" }),
          "Between groups.\n",
        ),
        async () => {
          await finalReady;
          return fakeCodexFinalText(MARKDOWN);
        },
      ]);
      providers.push(provider);

      const session = await TmuxSession.create({
        isolated: true,
        cmd: terminalCommand([
          "ask",
          "--auto",
          "--no-save",
          "Inspect fixture.txt and render the response.",
        ]),
        cwd: root.workspace,
        env: { ...providerEnv(root.home, provider), NO_COLOR: undefined },
        width: 120,
        height: 40,
        remainOnExit: true,
      });
      sessions.push(session);

      await session.waitForText("Between groups.", TIMEOUT);
      await session.resizeWindow(104, 36);
      releaseFinal!();
      await session.waitForText("__HANDWORK_EXIT_0__", TIMEOUT);
      const pane = await session.capturePane();
      const scrollback = await session.captureFullScrollback();
      const escaped = await session.captureFullScrollbackEscapes();
      expect(scrollback).toContain("Inspect fixture.txt and render the response.");
      expect(pane.match(/1 tool call · 1 read/g)).toHaveLength(2);
      expect(pane).toContain("Reading fixture.txt");
      expect(pane).toContain("Between groups.");
      expect(pane).toContain("Reading missing.txt");
      expect(pane).toContain("failed");
      expect(pane).toContain("Ask presentation");
      expect(pane).toContain("bold and docs");
      expect(pane).toContain("first item");
      expect(pane).toContain("const answer: u8 = 42;");
      expect(pane).toContain("─ zig ─");
      expect(pane).not.toContain("│ const answer: u8 = 42;");
      expect(pane).not.toContain("# Ask presentation");
      expect(pane).not.toContain("**bold**");
      expect(escaped).toContain("\x1b[");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "--no-color keeps the TTY layout without handwork styles or hyperlinks",
    async () => {
      const root = createRoot();
      const provider = startFakeCodex([fakeCodexFinalText(MARKDOWN)]);
      providers.push(provider);

      const session = await TmuxSession.create({
        isolated: true,
        cmd: terminalCommand([
          "ask",
          "--no-color",
          "--no-save",
          "Render the no-color fixture.",
        ]),
        cwd: root.workspace,
        env: { ...providerEnv(root.home, provider), NO_COLOR: undefined },
        width: 120,
        height: 40,
        remainOnExit: true,
      });
      sessions.push(session);

      await session.waitForText("__HANDWORK_EXIT_0__", TIMEOUT);
      const pane = await session.captureFullScrollback();
      const escaped = await session.captureFullScrollbackEscapes();
      expect(pane).toContain("Render the no-color fixture.");
      expect(pane).toContain("Ask presentation");
      expect(pane).toContain("bold and docs");
      expect(pane).toContain("const answer: u8 = 42;");
      expect(escaped).not.toMatch(/\x1b\[[0-9;]*m/);
      expect(escaped).not.toContain("\x1b]8;");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "light theme uses readable syntax colors in TTY code blocks with redirected stdin",
    async () => {
      const root = createRoot();
      const provider = startFakeCodex([fakeCodexFinalText(MARKDOWN)]);
      providers.push(provider);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      const session = await TmuxSession.create({
        isolated: true,
        cmd: `${terminalCommand([
          "ask",
          "--no-save",
          "Render the light-theme fixture.",
        ])} </dev/null`,
        cwd: root.workspace,
        env: {
          ...providerEnv(root.home, provider),
          HANDWORK_THEME: "light",
          NO_COLOR: undefined,
        },
        width: 120,
        height: 40,
        remainOnExit: true,
        stderrPath,
      });
      sessions.push(session);

      await session.waitForText("__HANDWORK_EXIT_0__", TIMEOUT);
      const escaped = await session.captureFullScrollbackEscapes();
      expect(escaped).toContain("\x1b[38;5;238mconst\x1b[39m");
      expect(escaped).not.toContain("\x1b[38;5;252mconst\x1b[39m");
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TTY output taller than the pane survives in native scrollback",
    async () => {
      const root = createRoot();
      const answerLines = Array.from(
        { length: 60 },
        (_, index) => `ANSWER_LINE_${String(index + 1).padStart(2, "0")}`,
      );
      const provider = startFakeCodex([
        fakeCodexSse([
          ...answerLines.map((line) => ({ type: "response.output_text.delta", delta: `${line}\n` })),
          { type: "response.completed", response: { status: "completed", usage: { input_tokens: ({
              inputTokens: { total: 3 },
              outputTokens: { total: 60 },
            }).inputTokens?.total ?? 0, output_tokens: ({
              inputTokens: { total: 3 },
              outputTokens: { total: 60 },
            }).outputTokens?.total ?? 0 } } },
        ]),
      ]);
      providers.push(provider);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      const session = await TmuxSession.create({
        isolated: true,
        cmd: terminalCommand([
          "ask",
          "--no-save",
          "Render every answer line.",
        ]),
        cwd: root.workspace,
        env: providerEnv(root.home, provider),
        width: 80,
        height: 12,
        minimumHistoryLines: 200,
        remainOnExit: true,
        stderrPath,
      });
      sessions.push(session);

      await session.waitForText("__HANDWORK_EXIT_0__", TIMEOUT);
      const scrollback = await session.captureFullScrollback();
      let previousIndex = -1;
      for (const line of answerLines) {
        const index = scrollback.indexOf(line);
        expect(index, line).toBeGreaterThan(previousIndex);
        previousIndex = index;
      }
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TTY prints the header before output and releases while the response is open",
    async () => {
      const root = createRoot();
      const answerLines = Array.from(
        { length: 40 },
        (_, index) => `OPEN_STREAM_LINE_${String(index + 1).padStart(2, "0")}`,
      );
      let releaseOutput = () => {};
      const outputGate = new Promise<void>((resolve) => {
        releaseOutput = resolve;
      });
      let releaseResponse = () => {};
      const responseGate = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      const provider = startDynamicFakeCodex(() => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              await outputGate;
              for (const line of answerLines) {
                controller.enqueue(encoder.encode(
                  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: `${line}\n` })}\n\n`,
                ));
              }
              await responseGate;
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: ({
                    inputTokens: { total: 3 },
                    outputTokens: { total: answerLines.length },
                  }).inputTokens?.total ?? 0, output_tokens: ({
                    inputTokens: { total: 3 },
                    outputTokens: { total: answerLines.length },
                  }).outputTokens?.total ?? 0 } } })}\n\ndata: [DONE]\n\n`,
              ));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      providers.push(provider);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      const session = await TmuxSession.create({
        isolated: true,
        cmd: terminalCommand([
          "ask",
          "--no-save",
          "Stream every answer line.",
        ]),
        cwd: root.workspace,
        env: providerEnv(root.home, provider),
        width: 80,
        height: 12,
        minimumHistoryLines: 200,
        remainOnExit: true,
        stderrPath,
      });
      sessions.push(session);

      try {
        const requestDeadline = Date.now() + 5_000;
        while (provider.requestCount() === 0 && Date.now() < requestDeadline) {
          await Bun.sleep(25);
        }
        expect(provider.requestCount()).toBe(1);

        const headerDeadline = Date.now() + 5_000;
        let initialScrollback = "";
        while (Date.now() < headerDeadline) {
          initialScrollback = await session.captureFullScrollback();
          if (
            initialScrollback.includes("Run /help for commands") &&
            initialScrollback.includes("Stream every answer line.")
          ) break;
          await Bun.sleep(25);
        }
        expect(initialScrollback).toContain("Run /help for commands");
        expect(initialScrollback).toContain("Stream every answer line.");
        expect(initialScrollback).not.toContain(answerLines[0]!);
        expect(initialScrollback.indexOf("Run /help for commands")).toBeLessThan(
          initialScrollback.indexOf("Stream every answer line."),
        );

        releaseOutput();
        const releaseDeadline = Date.now() + 5_000;
        let openScrollback = "";
        while (Date.now() < releaseDeadline) {
          openScrollback = await session.captureFullScrollback();
          if (openScrollback.includes(answerLines[0]!)) break;
          await Bun.sleep(25);
        }
        expect(openScrollback).toContain(answerLines[0]!);
      } finally {
        releaseOutput();
        releaseResponse();
      }

      await session.waitForText("__HANDWORK_EXIT_0__", TIMEOUT);
      const finalScrollback = await session.captureFullScrollback();
      expect(finalScrollback.split("Run /help for commands")).toHaveLength(2);
      for (const line of answerLines) {
        expect(finalScrollback.split(line)).toHaveLength(2);
      }
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TTY wrapped output stays ordered and appears exactly once",
    async () => {
      const root = createRoot();
      const answerLines = Array.from(
        { length: 7 },
        (_, index) =>
          `WRAPPED_LINE_${String(index + 1).padStart(2, "0")} ${"x".repeat(190)}`,
      );
      const provider = startFakeCodex([
        () => fakeCodexStreamingText(answerLines, 3),
      ]);
      providers.push(provider);
      const stderrPath = join(root.root, "stderr.log");
      writeFileSync(stderrPath, "");

      const session = await TmuxSession.create({
        isolated: true,
        cmd: terminalCommand([
          "ask",
          "--no-save",
          "Render every wrapped answer line.",
        ]),
        cwd: root.workspace,
        env: providerEnv(root.home, provider),
        width: 100,
        height: 20,
        minimumHistoryLines: 100,
        remainOnExit: true,
        stderrPath,
      });
      sessions.push(session);

      await session.waitForText(/__HANDWORK_EXIT_[0-9]+__/, TIMEOUT);
      const scrollback = await session.captureFullScrollback();
      expect(scrollback).toContain("__HANDWORK_EXIT_0__");
      let previousIndex = -1;
      for (const line of answerLines) {
        const marker = line.slice(0, "WRAPPED_LINE_00".length);
        const index = scrollback.indexOf(marker);
        expect(index, marker).toBeGreaterThan(previousIndex);
        expect(scrollback.split(marker)).toHaveLength(2);
        previousIndex = index;
      }
      expect(readFileSync(stderrPath, "utf8")).toBe("");
    },
    TIMEOUT,
  );

  test.skipIf(!tmuxAvailable())(
    "TTY Minimal hides context and auto-approval notices",
    async () => {
      const root = createRoot();
      const instructions = join(root.root, "instructions.md");
      writeFileSync(instructions, "# Fixture instructions\n");
      symlinkSync(instructions, join(root.workspace, "AGENTS.md"));
      const provider = startFakeCodex(
        [
          fakeShellRun("write_fixture", "printf notice-test > ask-notice.txt", {
            timeout_ms: 600_000,
          }),
          fakeCodexFinalText("Notice filtering complete.\n"),
        ],
        { classifierResponses: [fakeCodexPermissionDecision()] },
      );
      providers.push(provider);

      const session = await TmuxSession.create({
        isolated: true,
        cmd: terminalCommand([
          "ask",
          "--auto",
          "--no-save",
          "Run the notice filtering fixture.",
        ]),
        cwd: root.workspace,
        env: { ...providerEnv(root.home, provider), NO_COLOR: undefined },
        width: 120,
        height: 40,
        remainOnExit: true,
      });
      sessions.push(session);

      await session.waitForText("__HANDWORK_EXIT_0__", TIMEOUT);
      const scrollback = await session.captureFullScrollback();
      expect(scrollback).toContain("Run the notice filtering fixture.");
      expect(scrollback).toContain("Notice filtering complete.");
      expect(scrollback).toContain("1 tool call · 1 command");
      expect(scrollback).not.toContain("project instructions");
      expect(scrollback).not.toContain("Auto agent approved this request");
      expect(scrollback).not.toContain("● System:");
    },
    TIMEOUT,
  );
});
