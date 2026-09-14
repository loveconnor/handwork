import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildObservedCommand,
  heldFakeCodexFinalText,
  isVolatileTokenStatusRow,
  paneExitMatches,
  parseSingleChildPid,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const tmuxTest = test.skipIf(!tmuxAvailable());


test("pane exit matching requires the expected observed status", () => {
  expect(paneExitMatches({ dead: false, status: null }, 0)).toBe(false);
  expect(paneExitMatches({ dead: true, status: null }, 0)).toBe(false);
  expect(paneExitMatches({ dead: true, status: 0 }, 0)).toBe(true);
  expect(paneExitMatches({ dead: true, status: 1 }, 0)).toBe(false);
  expect(paneExitMatches({ dead: true, status: 37 }, 37)).toBe(true);
});

test("launched process PID parsing requires one direct child", () => {
  expect(parseSingleChildPid("31415\n", 27182)).toBe(31415);
  expect(() => parseSingleChildPid("", 27182)).toThrow(
    "tmux pane process 27182 has 0 direct children",
  );
  expect(() => parseSingleChildPid("31415\n31416\n", 27182)).toThrow(
    "tmux pane process 27182 has 2 direct children",
  );
  expect(() => parseSingleChildPid("not-a-pid\n", 27182)).toThrow(
    "invalid child PID",
  );
});

test("volatile token status rows stay narrowly classified", () => {
  expect(isVolatileTokenStatusRow("  (↑10 ↓5)")).toBe(true);
  expect(isVolatileTokenStatusRow("  0s (↑10 ↓5)")).toBe(true);
  expect(isVolatileTokenStatusRow("  1m 2s (↑1.2k ↓3k)")).toBe(true);
  expect(isVolatileTokenStatusRow("• Streaming (↑10 ↓5)")).toBe(false);
  expect(isVolatileTokenStatusRow("ordinary output (↑10 ↓5)")).toBe(false);
});

test("observed command keeps wrapper signal diagnostics out of captured stderr", () => {
  const root = mkdtempSync(join(tmpdir(), "handwork-observed-command-"));
  const stderrPath = join(root, "handwork.stderr");
  const exitStatusPath = join(root, "exit-status");

  try {
    for (const shellPath of ["/bin/sh", "/bin/dash"].filter(existsSync)) {
      const observedCommand = buildObservedCommand(
        `/bin/sh -c 'printf "handwork stderr\\n" >&2; kill -TERM $$'`,
        stderrPath,
        exitStatusPath,
      ).replaceAll("/bin/sh", shellPath);
      const result = spawnSync(shellPath, ["-c", observedCommand], {
        encoding: "utf8",
      });

      expect(result.status).toBe(143);
      expect(readFileSync(stderrPath, "utf8")).toBe("handwork stderr\n");
      expect(readFileSync(exitStatusPath, "utf8")).toBe("143\n");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

tmuxTest("pane environment does not poison a shared tmux server", async () => {
  const socketName = `handwork-pe-${process.pid}-${Date.now().toString(36)}`;
  const root = mkdtempSync(join(tmpdir(), "handwork-tmux-pane-env-isolation-"));
  const seededHome = join(root, "seeded-home");
  const probePath = join(root, "probe.mjs");
  const firstResultPath = join(root, "first.json");
  const secondResultPath = join(root, "second.json");
  const originalRecord = process.env.HANDWORK_RECORD;
  let first: TmuxSession | undefined;
  let second: TmuxSession | undefined;

  try {
    delete process.env.HANDWORK_RECORD;
    writeFileSync(
      probePath,
      `await Bun.write(process.argv[2], JSON.stringify({\n` +
        `  HOME: process.env.HOME ?? null,\n` +
        `  HANDWORK_RECORD: process.env.HANDWORK_RECORD ?? null,\n` +
        `}));\nawait Bun.sleep(5_000);\n`,
    );

    first = await TmuxSession.create({
      cmd: `${process.execPath} ${probePath} ${firstResultPath}`,
      socketName,
      startupWaitMs: 100,
      env: {
        HOME: seededHome,
        HANDWORK_RECORD: "stale-record-path",
      },
    });
    second = await TmuxSession.create({
      cmd: `${process.execPath} ${probePath} ${secondResultPath}`,
      socketName,
      startupWaitMs: 100,
    });

    const resultDeadline = Date.now() + 5_000;
    while (
      (!existsSync(firstResultPath) || !existsSync(secondResultPath)) &&
      Date.now() < resultDeadline
    ) {
      await Bun.sleep(25);
    }
    expect(existsSync(firstResultPath)).toBe(true);
    expect(existsSync(secondResultPath)).toBe(true);
    expect(JSON.parse(readFileSync(firstResultPath, "utf8"))).toEqual({
      HOME: seededHome,
      HANDWORK_RECORD: "stale-record-path",
    });
    expect(JSON.parse(readFileSync(secondResultPath, "utf8"))).toEqual({
      HOME: process.env.HOME ?? null,
      HANDWORK_RECORD: null,
    });
  } finally {
    await second?.kill();
    await first?.kill();
    try {
      execFileSync("tmux", ["-L", socketName, "kill-server"], {
        stdio: "pipe",
      });
    } catch {}
    if (originalRecord === undefined) delete process.env.HANDWORK_RECORD;
    else process.env.HANDWORK_RECORD = originalRecord;
    rmSync(root, { recursive: true, force: true });
  }
});

tmuxTest("minimum history lines survive a fresh tmux server restart", async () => {
  const socketName = `handwork-history-limit-${process.pid}-${Date.now()}`;
  let first: TmuxSession | undefined;
  let session: TmuxSession | undefined;
  try {
    first = await TmuxSession.create({
      cmd: "sleep 60",
      minimumHistoryLines: 100_000,
      socketName,
      startupWaitMs: 0,
    });
    expect(first.historyLimit()).toBe(100_000);
    await first.kill();
    first = undefined;

    session = await TmuxSession.create({
      cmd: "sleep 60",
      minimumHistoryLines: 100_000,
      socketName,
      startupWaitMs: 0,
    });
    expect(session.historyLimit()).toBe(100_000);
  } finally {
    await session?.kill();
    await first?.kill();
    try {
      execFileSync("tmux", ["-L", socketName, "kill-server"], {
        stdio: "pipe",
      });
    } catch {}
  }
});
