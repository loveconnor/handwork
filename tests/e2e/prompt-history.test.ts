import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
import {
  FAKE_CODEX_MODEL,
  hasEmptyComposer,
  isComposerLine,
  startDynamicFakeCodex,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 20_000;
const REJECTED_PROVIDER_AUTH = {
  HANDWORK_AUTH_MODE: "host-managed",
  NO_COLOR: "1",
};

const serialTest = test.serial;

function rejectedProviderEnv(
  home: string,
  provider: ReturnType<typeof startDynamicFakeCodex>,
) {
  return {
    ...REJECTED_PROVIDER_AUTH,
    HOME: home,
    HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
    HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
    HANDWORK_MODEL: FAKE_CODEX_MODEL,
  };
}

function currentComposerLine(pane: string): string {
  return pane.split("\n").filter(isComposerLine).at(-1) ?? "";
}

function slashMenuRows(pane: string): string[] {
  return pane.split("\n").filter((line) =>
    !isComposerLine(line) && line.trimStart().startsWith("/")
  );
}

async function disablePromptHistory(
  session: TmuxSession,
  settingsPath: string,
): Promise<void> {
  await session.sendText("/settings");
  await session.waitForText("←→ change", TIMEOUT);
  await session.sendLiteral("prompt history");
  await session.waitForPane(
    (pane) => pane.includes("Prompt history") && !pane.includes("Startup scrollback"),
    TIMEOUT,
  );
  await session.sendKeys("Left");
  const deadline = Date.now() + TIMEOUT;
  let enabled: unknown;
  while (Date.now() < deadline) {
    if (existsSync(settingsPath)) {
      enabled = JSON.parse(readFileSync(settingsPath, "utf8")).prompt_history?.enabled;
      if (enabled === false) break;
    }
    await Bun.sleep(25);
  }
  if (enabled !== false) throw new Error("Timed out disabling prompt history");
  await session.sendKeys("Escape");
  await session.waitForPane(
    (pane) => hasEmptyComposer(pane) && !pane.includes("←→ change"),
    TIMEOUT,
  );
}

describe.skipIf(!tmuxAvailable())("prompt history", () => {
  let session: TmuxSession | null = null;
  let provider: ReturnType<typeof startDynamicFakeCodex> | null = null;

  afterEach(async () => {
    await session?.kill();
    session = null;
    provider?.stop();
    provider = null;
  });

  serialTest(
    "accepted prompts and slash commands survive restart",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-prompt-history-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        const workspaceRoot = realpathSync(workspace);
        provider = startDynamicFakeCodex(() =>
          new Response(JSON.stringify({ error: { message: "rejected" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        );

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: rejectedProviderEnv(home, provider),
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendText("PLAN10_PROMPT_HISTORY_SENTINEL");
        await session.waitForText("HTTP 401", TIMEOUT);
        await session.sendText("/help");
        await session.waitForText("Commands 35", TIMEOUT);
        await session.sendKeys("Escape");
        await session.waitForPane((pane) => !pane.includes("enter open"), TIMEOUT);
        await session.sendText("/quit");
        await session.waitForSessionEnd(TIMEOUT);
        session = null;

        const historyPath = join(home, ".handwork", "history.jsonl");
        const history = readFileSync(historyPath, "utf8");
        expect(history).toContain("PLAN10_PROMPT_HISTORY_SENTINEL");
        expect(history).toContain("/help");
        expect(history).toContain("/quit");

        session = await TmuxSession.create({
          cwd: workspaceRoot,
          env: rejectedProviderEnv(home, provider),
        });
        await session.waitForText("Run /help", TIMEOUT);

        await session.sendLiteral("/");
        await session.waitForPane((current) => slashMenuRows(current).length > 0, TIMEOUT);
        await session.sendKeys("C-u");
        await session.waitForPane(hasEmptyComposer, TIMEOUT);

        await session.sendKeys("Up");
        let pane = await session.waitForPane(
          (current) => currentComposerLine(current).includes("/quit"),
          TIMEOUT,
        );
        expect(currentComposerLine(pane)).toContain("/quit");
        expect(slashMenuRows(pane)).toEqual([]);

        await session.sendKeys("Up");
        await session.sendKeys("Up");
        pane = await session.waitForPane(
          (current) => currentComposerLine(current).includes("/help"),
          TIMEOUT,
        );
        expect(currentComposerLine(pane)).toContain("/help");
        expect(slashMenuRows(pane)).toEqual([]);

        await session.sendKeys("Up");
        await session.sendKeys("Up");
        pane = await session.waitForPane(
          (current) => currentComposerLine(current).includes("PLAN10_PROMPT_HISTORY_SENTINEL"),
          TIMEOUT,
        );
        expect(currentComposerLine(pane)).toContain("PLAN10_PROMPT_HISTORY_SENTINEL");

        await session.sendKeys("Down");
        pane = await session.waitForPane(
          (current) => currentComposerLine(current).includes("/help"),
          TIMEOUT,
        );
        expect(slashMenuRows(pane)).toEqual([]);

        await session.sendKeys("BSpace");
        pane = await session.waitForPane(
          (current) =>
            currentComposerLine(current).includes("/hel") &&
            slashMenuRows(current).length > 0,
          TIMEOUT,
        );
        expect(currentComposerLine(pane)).toContain("/hel");
        await session.sendKeys("C-u");
        await session.waitForPane(hasEmptyComposer, TIMEOUT);
        expect(session.isAlive()).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  serialTest(
    "read-only prompt-history bootstrap does not create state in an unwritable home",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-prompt-history-no-create-"));
      try {
        const home = join(root, "home");
        const workspace = join(root, "workspace");
        mkdirSync(home);
        mkdirSync(workspace);
        chmodSync(home, 0o500);

        try {
          session = await TmuxSession.create({
            cwd: realpathSync(workspace),
            env: {
              ...REJECTED_PROVIDER_AUTH,
              HOME: realpathSync(home),
            },
          });
          await session.waitForText("Run /help", TIMEOUT);
          expect(existsSync(join(home, ".handwork"))).toBe(false);
        } finally {
          chmodSync(home, 0o700);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  serialTest(
    "recording can be disabled from settings",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-prompt-history-scope-"));
      try {
        const home = join(root, "home");
        const workspaceA = join(root, "workspace-a");
        const workspaceB = join(root, "workspace-b");
        mkdirSync(home);
        mkdirSync(workspaceA);
        mkdirSync(workspaceB);
        provider = startDynamicFakeCodex(() =>
          new Response(JSON.stringify({ error: { message: "rejected" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        );

        for (const [workspace, prompt] of [
          [workspaceA, "PLAN10_HISTORY_WORKSPACE_A"],
          [workspaceB, "PLAN10_HISTORY_WORKSPACE_B"],
        ] as const) {
          session = await TmuxSession.create({
            cwd: realpathSync(workspace),
            env: rejectedProviderEnv(home, provider),
          });
          await session.waitForText("Run /help", TIMEOUT);
          await session.sendText(prompt);
          await session.waitForText("HTTP 401", TIMEOUT);
          await session.sendText("/quit");
          await session.waitForSessionEnd(TIMEOUT);
          session = null;
        }

        const historyPath = join(home, ".handwork", "history.jsonl");
        expect(readFileSync(historyPath, "utf8")).toContain(
          "PLAN10_HISTORY_WORKSPACE_A",
        );
        expect(readFileSync(historyPath, "utf8")).toContain(
          "PLAN10_HISTORY_WORKSPACE_B",
        );

        session = await TmuxSession.create({
          cwd: realpathSync(workspaceA),
          env: rejectedProviderEnv(home, provider),
        });
        await session.waitForText("Run /help", TIMEOUT);
        await disablePromptHistory(session, join(home, ".handwork", "settings.json"));
        await session.sendText("PLAN10_HISTORY_DISABLED");
        await session.waitForText("HTTP 401", TIMEOUT);
        await session.waitForPane(hasEmptyComposer, TIMEOUT);
        await session.sendKeys("Up");
        let recalled = await session.waitForPane(
          (pane) => {
            const composer = currentComposerLine(pane);
            return (
              composer.includes("/settings") ||
              composer.includes("PLAN10_HISTORY_DISABLED")
            );
          },
          TIMEOUT,
        );
        let composer = currentComposerLine(recalled);
        expect(composer).not.toContain("PLAN10_HISTORY_DISABLED");
        expect(composer).toContain("/settings");

        await session.sendKeys("Up");
        await session.sendKeys("Up");
        recalled = await session.waitForPane(
          (pane) => {
            const current = currentComposerLine(pane);
            return (
              current.includes("/quit") ||
              current.includes("PLAN10_HISTORY_DISABLED")
            );
          },
          TIMEOUT,
        );
        composer = currentComposerLine(recalled);
        expect(composer).not.toContain("PLAN10_HISTORY_DISABLED");
        expect(composer).toContain("/quit");

        await session.sendKeys("Up");
        await session.sendKeys("Up");
        recalled = await session.waitForPane(
          (pane) => {
            const current = currentComposerLine(pane);
            return (
              current.includes("PLAN10_HISTORY_WORKSPACE_A") ||
              current.includes("PLAN10_HISTORY_DISABLED")
            );
          },
          TIMEOUT,
        );
        composer = currentComposerLine(recalled);
        expect(composer).not.toContain("PLAN10_HISTORY_DISABLED");
        expect(composer).toContain("PLAN10_HISTORY_WORKSPACE_A");
        await session.sendKeys("C-u");
        await session.waitForPane(hasEmptyComposer, TIMEOUT);
        await session.kill();
        session = null;

        const history = readFileSync(historyPath, "utf8");
        expect(history).toContain("PLAN10_HISTORY_WORKSPACE_A");
        expect(history).toContain("PLAN10_HISTORY_WORKSPACE_B");
        expect(history).toContain("/settings");
        expect(history).not.toContain("PLAN10_HISTORY_DISABLED");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    90_000,
  );

  serialTest(
    "startup scans beyond one mebibyte of newer interleaved workspace records",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "handwork-prompt-history-large-"));
      try {
        const home = join(root, "home");
        const workspaceA = join(root, "workspace-a");
        const workspaceB = join(root, "workspace-b");
        mkdirSync(join(home, ".handwork"), { recursive: true, mode: 0o700 });
        mkdirSync(workspaceA);
        mkdirSync(workspaceB);
        const workspaceARoot = realpathSync(workspaceA);
        const workspaceBRoot = realpathSync(workspaceB);

        const records: string[] = [];
        for (let index = 0; index < 100; index += 1) {
          records.push(JSON.stringify({
            schema_version: 1,
            timestamp_ms: index,
            workspace_root: workspaceARoot,
            text: `PLAN10_HISTORY_KEPT_${index.toString().padStart(3, "0")}`,
          }));
        }
        const filler = "x".repeat(2048);
        for (let index = 0; records.join("\n").length < 1_200 * 1024; index += 1) {
          records.push(JSON.stringify({
            schema_version: 1,
            timestamp_ms: 1000 + index,
            workspace_root: workspaceBRoot,
            text: filler,
          }));
        }
        writeFileSync(
          join(home, ".handwork", "history.jsonl"),
          records.join("\n") + "\n",
          { mode: 0o600 },
        );
        writeFileSync(join(home, ".handwork", "sessions"), "blocked\n", {
          mode: 0o600,
        });

        session = await TmuxSession.create({
          cwd: workspaceARoot,
          env: {
            ...REJECTED_PROVIDER_AUTH,
            HOME: home,
          },
        });
        await session.waitForText("Run /help", TIMEOUT);
        await session.sendKeys("Up");
        const pane = await session.waitForText("PLAN10_HISTORY_KEPT_099", TIMEOUT);
        expect(pane).toContain("PLAN10_HISTORY_KEPT_099");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
