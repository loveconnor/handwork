import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDWORK_BIN, runHandwork } from "../evals/eval-helpers";
import {
  fakeCodexFinalText,
  startDynamicFakeCodex,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const MAIN_MODEL = "openai/gpt-5.5";
const TITLE_MODEL = "openai/gpt-5.6-luna";
const GENERATED_TITLE = "Renderer Loop Refactor";

type FixtureRoot = {
  root: string;
  home: string;
  workspace: string;
};

function createFixtureRoot(label: string, settings: string = "{}"): FixtureRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `handwork-session-title-${label}-`)));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".handwork"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, ".handwork", "settings.json"), settings);
  return { root, home, workspace: realpathSync(workspace) };
}

function startTitleAwareProvider() {
  return startDynamicFakeCodex(_raw => fakeCodexFinalText("MAIN_ANSWER_OK"), {
    models: [{ id: MAIN_MODEL, type: "language", tags: ["tool-use"] }],
    titleResponses: [fakeCodexFinalText(GENERATED_TITLE)],
  });
}

function baseEnv(root: FixtureRoot, provider: { baseUrl: string; chatUrl: string }) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root.home,
    HANDWORK_AUTH_MODE: "host-managed",
    HANDWORK_DISABLE_KEYCHAIN: "1",
    HANDWORK_E2E_DISABLE_DOTENV: "1",
    HANDWORK_AUTO_UPGRADE: "0",
    HANDWORK_SOUND: "0",
    HANDWORK_SKIP_ONBOARDING: "1",
    HANDWORK_MODEL: MAIN_MODEL,
    HANDWORK_PERMISSION_MODE: "full-access",
    HANDWORK_MAX_AGENT_STEPS: "2",
    HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
    HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
    HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
    HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
  };
}

function sessionTitles(root: FixtureRoot): string[] {
  const sessionsDir = join(root.home, ".handwork", "sessions");
  if (!existsSync(sessionsDir)) return [];
  const titles: string[] = [];
  for (const id of readdirSync(sessionsDir)) {
    const manifest = join(sessionsDir, id, "session.json");
    if (!existsSync(manifest)) continue;
    const value = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof value.title === "string") titles.push(value.title);
  }
  return titles;
}

function titleRequests(provider: ReturnType<typeof startTitleAwareProvider>) {
  return provider.titleRequests;
}

test("handwork ask generates a model title for a fresh session", async () => {
  const root = createFixtureRoot("ask");
  const provider = startTitleAwareProvider();
  try {
    const result = await runHandwork(["ask", "refactor the renderer loop to fix the crash"], {
      cwd: root.workspace,
      env: baseEnv(root, provider),
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("MAIN_ANSWER_OK");

    const titleCalls = titleRequests(provider);
    expect(titleCalls.length).toBe(1);
    expect(titleCalls[0].headers.get("ai-language-model-id")).toBe(TITLE_MODEL);
    expect(titleCalls[0].body).toContain("refactor the renderer loop");

    expect(sessionTitles(root)).toContain(GENERATED_TITLE);

    const list = await runHandwork(["sessions", "--json"], {
      cwd: root.workspace,
      env: baseEnv(root, provider),
      timeoutMs: 15_000,
    });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(GENERATED_TITLE);
  } finally {
    provider.stop();
  }
});

test("handwork ask keeps the derived title when session_titles is off", async () => {
  const root = createFixtureRoot("disabled", JSON.stringify({ session_titles: false }));
  const provider = startTitleAwareProvider();
  try {
    const result = await runHandwork(["ask", "refactor the renderer loop to fix the crash"], {
      cwd: root.workspace,
      env: baseEnv(root, provider),
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("MAIN_ANSWER_OK");
    expect(titleRequests(provider).length).toBe(0);
    expect(sessionTitles(root)).not.toContain(GENERATED_TITLE);
  } finally {
    provider.stop();
  }
});

test("handwork ask keeps the derived title when the title model output is unusable", async () => {
  const root = createFixtureRoot("unusable");
  const provider = startDynamicFakeCodex(_raw => fakeCodexFinalText("MAIN_ANSWER_OK"), {
    models: [{ id: MAIN_MODEL, type: "language", tags: ["tool-use"] }],
    titleResponses: [fakeCodexFinalText("\n  \n")],
  });
  try {
    const result = await runHandwork(["ask", "refactor the renderer loop to fix the crash"], {
      cwd: root.workspace,
      env: baseEnv(root, provider),
      timeoutMs: 30_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("MAIN_ANSWER_OK");
    const titles = sessionTitles(root);
    expect(titles.length).toBe(1);
    expect(titles[0]).not.toBe(GENERATED_TITLE);
    expect(titles[0].length).toBeGreaterThan(0);
  } finally {
    provider.stop();
  }
});

const SKIP_TMUX = !tmuxAvailable();

test.skipIf(SKIP_TMUX)("tui shows the generated session title", async () => {
  const root = createFixtureRoot("tui", JSON.stringify({ statusLine: { session: true } }));
  const provider = startTitleAwareProvider();
  let tui: TmuxSession | undefined;
  try {
    tui = await TmuxSession.create({
      cmd: JSON.stringify(HANDWORK_BIN),
      cwd: root.workspace,
      isolated: true,
      remainOnExit: true,
      env: baseEnv(root, provider),
    });
    await tui.waitForStableComposer(15000);
    await tui.sendText("refactor the renderer loop to fix the crash");
    await tui.waitForText("MAIN_ANSWER_OK", 20000);
    await tui.waitForText(GENERATED_TITLE, 15000);
    expect(sessionTitles(root)).toContain(GENERATED_TITLE);
  } finally {
    await tui?.kill();
    provider.stop();
  }
}, 60_000);
