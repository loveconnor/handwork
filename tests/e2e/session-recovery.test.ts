import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  fakeCodexToolCall,
  fakeShellRun,
  startFakeCodex,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

const TIMEOUT = 30_000;

function savedFileHashes(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  function visit(directory: string, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "session.lock") continue;
      const relative = join(prefix, entry.name);
      if (entry.isDirectory()) visit(join(directory, entry.name), relative);
      else hashes[relative] = createHash("sha256")
        .update(readFileSync(join(directory, entry.name)))
        .digest("hex");
    }
  }
  visit(root);
  return hashes;
}

function createFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  return {
    root,
    home: realpathSync(home),
    workspace: realpathSync(workspace),
  };
}

function providerEnv(
  fixture: ReturnType<typeof createFixture>,
  provider: ReturnType<typeof startFakeCodex>,
) {
  return {
    HOME: fixture.home,
    HANDWORK_AUTH_MODE: "host-managed",

    HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
    HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
    HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
    HANDWORK_MODEL: FAKE_CODEX_MODEL,
    HANDWORK_AUTO_UPGRADE: "0",
  };
}

async function createSavedSession(
  fixture: ReturnType<typeof createFixture>,
  provider: ReturnType<typeof startFakeCodex>,
): Promise<string> {
  const created = await runHandwork(
    ["ask", "--json", "--auto", "Create the first saved turn."],
    {
      cwd: fixture.workspace,
      env: providerEnv(fixture, provider),
      timeoutMs: TIMEOUT,
    },
  );
  expect(created.code).toBe(0);
  expect(created.stderr).toBe("");
  return JSON.parse(created.stdout).session_id;
}

async function continueSession(
  fixture: ReturnType<typeof createFixture>,
  provider: ReturnType<typeof startFakeCodex>,
  sessionId: string,
  latest = false,
) {
  return runHandwork(
    [
      "ask",
      "--json",
      "--auto",
      ...(latest ? ["--resume", "last"] : ["--resume-id", sessionId]),
      "Continue after recovery.",
    ],
    {
      cwd: fixture.workspace,
      env: providerEnv(fixture, provider),
      timeoutMs: TIMEOUT,
    },
  );
}

test("latest resume preserves an unrelated pending authority directory", async () => {
  const fixture = createFixture("handwork-latest-pending-");
  const provider = startFakeCodex([
    fakeCodexFinalText("SAVED_PARENT_CONTEXT"),
    fakeCodexFinalText("CONTINUED_PARENT_CONTEXT"),
  ]);
  try {
    const id = await createSavedSession(fixture, provider);
    const orphan = join(fixture.home, ".handwork", "sessions", "pending-authority");
    mkdirSync(orphan, { mode: 0o700 });
    writeFileSync(join(orphan, "authority.pending.json"), "pending", { mode: 0o600 });
    writeFileSync(join(orphan, "events.jsonl"), "unidentified saved data\n", { mode: 0o600 });
    const resumed = await continueSession(fixture, provider, id, true);
    expect(resumed.code).toBe(0);
    expect(resumed.stderr).toBe("");
    expect(JSON.parse(resumed.stdout).session_id).toBe(id);
    expect(provider.requests.at(-1)?.body).toContain("SAVED_PARENT_CONTEXT");
    expect(readFileSync(join(orphan, "events.jsonl"), "utf8")).toBe("unidentified saved data\n");
    expect(readFileSync(join(orphan, "authority.pending.json"), "utf8")).toBe("pending");
  } finally {
    provider.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, TIMEOUT);

test("resume keeps conversation history when accounting is damaged", async () => {
  const fixture = createFixture("handwork-accounting-resume-");
  const provider = startFakeCodex([
    fakeCodexFinalText("ACCOUNTING_HISTORY_RETAINED"),
    fakeCodexFinalText("ACCOUNTING_RESUME_COMPLETED"),
  ]);
  try {
    const id = await createSavedSession(fixture, provider);
    const dir = join(fixture.home, ".handwork", "sessions", id);
    const events = join(dir, "events.jsonl");
    const before = readFileSync(events);
    writeFileSync(join(dir, "usage-v2.json"), "{broken accounting", { mode: 0o600 });
    const resumed = await continueSession(fixture, provider, id);
    expect(resumed.code).toBe(0);
    expect(resumed.stderr).toBe("");
    expect(JSON.parse(resumed.stdout).session_id).toBe(id);
    expect(provider.requests.at(-1)?.body).toContain("ACCOUNTING_HISTORY_RETAINED");
    expect(readFileSync(events).subarray(0, before.length).equals(before)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "usage-v2.json"), "utf8")).snapshot.billing).toBe("incomplete");
  } finally {
    provider.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, TIMEOUT);

test("conversation language survives an ordinary saved turn and resume", async () => {
  const fixture = createFixture("handwork-language-resume-");
  const provider = startFakeCodex([
    fakeCodexFinalText("こんにちは。"),
    fakeCodexFinalText("完了しました。"),
  ]);
  try {
    const seeded = await runHandwork(["ask", "--json", "こんにちは。日本語で返答してください。"], {
      cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
    });
    expect(seeded.code).toBe(0);
    const id = JSON.parse(seeded.stdout).session_id;
    const metadata = join(fixture.home, ".handwork", "sessions", id, "session.json");
    expect(JSON.parse(readFileSync(metadata, "utf8")).conversation_language).toBe("ja");
    const resumed = await runHandwork(["ask", "--json", "--resume-id", id, "👍"], {
      cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
    });
    expect(resumed.code).toBe(0);
    expect(resumed.stderr).toBe("");
    expect(JSON.parse(readFileSync(metadata, "utf8")).conversation_language).toBe("ja");
  } finally {
    provider.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
}, TIMEOUT);

// Entirely synthetic schema-v3 data: no copied sessions, credentials, or child markers.

describe("session recovery", () => {
  test("unsupported accounting snapshot versions refuse recovery without changing the source", async () => {
    const fixture = createFixture("handwork-session-future-usage-");
    const provider = startFakeCodex([fakeCodexFinalText("SAVED_ACCOUNTING_VERSION")]);
    try {
      const id = await createSavedSession(fixture, provider);
      const sessions = join(fixture.home, ".handwork", "sessions");
      const source = join(sessions, id);
      const usagePath = join(source, "usage-v2.json");
      const usage = JSON.parse(readFileSync(usagePath, "utf8"));
      usage.snapshot.schema_version = 4;
      writeFileSync(usagePath, JSON.stringify(usage), { mode: 0o600 });
      const before = savedFileHashes(source);
      const sessionNames = readdirSync(sessions).sort();
      const result = await runHandwork(["session", "recover", id, "--json"], {
        cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
      });
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).toContain("UnsupportedUsageSidecar");
      expect(savedFileHashes(source)).toEqual(before);
      expect(readdirSync(sessions).sort()).toEqual(sessionNames);
    } finally {
      provider.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  for (const damagedTail of [false, true]) {
    test(`corrupt accounting recovers a source-preserving copy, damaged tail=${damagedTail}`, async () => {
      const fixture = createFixture("handwork-session-usage-copy-");
      const provider = startFakeCodex([
        fakeCodexFinalText("ACCOUNTING_RECOVERY_SAVED"),
        fakeCodexFinalText("ACCOUNTING_RECOVERY_CONTINUED"),
      ]);
      try {
        const id = await createSavedSession(fixture, provider);
        const source = join(fixture.home, ".handwork", "sessions", id);
        const committed = readFileSync(join(source, "events.jsonl"));
        writeFileSync(join(source, "usage-v2.json"), "{broken usage", { mode: 0o600 });
        if (damagedTail) appendFileSync(join(source, "events.jsonl"), "{broken tail");
        const before = savedFileHashes(source);
        const result = await runHandwork(["session", "recover", id, "--json"], {
          cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
        });
        expect(result.code).toBe(0);
        expect(result.stderr).toBe("");
        const recovered = JSON.parse(result.stdout);
        expect(recovered).toMatchObject({ status: "recovered", usage_incomplete: true, source_id: id });
        expect(recovered.recovered_id).not.toBe(id);
        expect(savedFileHashes(source)).toEqual(before);
        const copy = join(fixture.home, ".handwork", "sessions", recovered.recovered_id);
        expect(readFileSync(join(copy, "events.jsonl"))).toEqual(committed);
        expect(JSON.parse(readFileSync(join(copy, "usage-v2.json"), "utf8")).snapshot.billing).toBe("incomplete");
        const continued = await continueSession(fixture, provider, recovered.recovered_id);
        expect(continued.code).toBe(0);
        expect(continued.stderr).toBe("");
        expect(provider.requests.at(-1)!.body).toContain("ACCOUNTING_RECOVERY_SAVED");
        expect(JSON.parse(readFileSync(join(copy, "usage-v2.json"), "utf8")).snapshot.billing).toBe("incomplete");
        expect(savedFileHashes(source)).toEqual(before);
      } finally {
        provider.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }

  

  test("recovery no-op requires a loadable current conversation", async () => {
    const fixture = createFixture("handwork-session-current-healthy-");
    const provider = startFakeCodex([fakeCodexFinalText("SAVED_HEALTHY")]);
    try {
      const id = await createSavedSession(fixture, provider);
      const source = join(fixture.home, ".handwork", "sessions", id);
      const before = savedFileHashes(source);
      const result = await runHandwork(["session", "recover", id, "--json"], {
        cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).code).toBe("SessionRecoveryNotNeeded");
      expect(savedFileHashes(source)).toEqual(before);
      expect(readdirSync(join(fixture.home, ".handwork", "sessions"))).toEqual([id]);
      expect(provider.requests).toHaveLength(1);
      async function expectRefused(code: string) {
        const damaged = savedFileHashes(source);
        const refused = await runHandwork(["session", "recover", id, "--json"], {
          cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
        });
        expect(refused.code).toBe(1);
        expect(refused.stderr).toBe("");
        expect(JSON.parse(refused.stdout).code).toBe(code);
        expect(refused.stdout).not.toContain("resume it normally");
        expect(savedFileHashes(source)).toEqual(damaged);
        expect(readdirSync(join(fixture.home, ".handwork", "sessions"))).toEqual([id]);
        expect(provider.requests).toHaveLength(1);
      }
      const permissionPath = join(source, "permissions.json");
      const permissions = readFileSync(permissionPath);
      writeFileSync(permissionPath, "{broken", { mode: 0o600 });
      await expectRefused("InvalidPermissionState");
      writeFileSync(permissionPath, "", { mode: 0o600 });
      await expectRefused("PermissionStateTooLarge");
      writeFileSync(permissionPath, permissions, { mode: 0o600 });
      const usagePath = join(source, "usage-v2.json");
      rmSync(usagePath);
      mkdirSync(usagePath, { mode: 0o700 });
      await expectRefused("InvalidUsageSidecar");
      expect(readdirSync(usagePath)).toEqual([]);
    } finally {
      provider.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  for (const { checkpointedTurn, missingUsage, fullCoverage, damagedUsage } of [
    { checkpointedTurn: false, missingUsage: false, fullCoverage: false, damagedUsage: false },
    { checkpointedTurn: true, missingUsage: false, fullCoverage: false, damagedUsage: false },
    { checkpointedTurn: false, missingUsage: true, fullCoverage: false, damagedUsage: false },
    { checkpointedTurn: false, missingUsage: false, fullCoverage: true, damagedUsage: false },
    { checkpointedTurn: false, missingUsage: false, fullCoverage: false, damagedUsage: true },
  ]) {
    test(`current conversation recovery preserves exact checkpoints and artifacts with open=${checkpointedTurn} missing usage=${missingUsage} full coverage=${fullCoverage} damaged usage=${damagedUsage}`, async () => {
      const fixture = createFixture("handwork-session-current-copy-");
      const responses = [
        fakeShellRun("saved-effect", "printf 'ONCE_RECOVERY_731\\n' >> effect.log; printf 'RESULT_RECOVERY_982\\n'"),
        fakeCodexFinalText("WORK_SAVED"),
      ];
      const provider = startFakeCodex(responses);
      try {
        const created = await runHandwork(["ask", "--json", "--full-access", "Save one command result."], {
          cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
        });
        expect(created.code).toBe(0);
        const id = JSON.parse(created.stdout).session_id;
        const source = join(fixture.home, ".handwork", "sessions", id);
        const eventPath = join(source, "events.jsonl");
        const metadataPath = join(source, "session.json");
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
        metadata.title = "Recovered work keeps its chosen title";
        writeFileSync(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
        if (missingUsage) rmSync(join(source, "usage-v2.json"));
        if (damagedUsage) writeFileSync(join(source, "usage-v2.json"), "{damaged usage", { mode: 0o600 });
        const records = readFileSync(eventPath, "utf8").trimEnd().split("\n").map(JSON.parse);
        if (fullCoverage) records[0].event.user.work_id = "covered-recovery-work";
        const stored = records.find((record) => record.event.tool_result).event.tool_result;
        const coverage = fullCoverage ? records[records.length - 1].seq : 1;
        const append = (event: object) => records.push({
          schema_version: 1, seq: records.length + 1, timestamp_ms: Date.now(), event,
        });
        append({ context_checkpoint: { covers_through_seq: coverage, summary: "<context_handoff>Saved command completed.</context_handoff>" } });
        append({ context_checkpoint: { covers_through_seq: coverage, summary: "<context_handoff>Retain the completed command and its result.</context_handoff>" } });
        if (checkpointedTurn) {
          append({ user: { text: "Keep the already completed stored read.", work_id: "checkpointed-recovery-work" } });
          append({ tool_call: { call_id: "checkpointed-read", tool_name: "read_tool_result", arguments_json: JSON.stringify({ handle: stored.artifact_ref }) } });
          append({ tool_result: { ...stored, call_id: "checkpointed-read", tool_name: "read_tool_result" } });
          append({ context_checkpoint: { covers_through_seq: 1, summary: "<context_handoff>Checkpointed read is already complete.</context_handoff>" } });
        }
        const prefix = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
        writeFileSync(eventPath, prefix + "invalid CORRUPT_TAIL_MUST_NOT_REPLAY\n", { mode: 0o600 });
        const before = savedFileHashes(source);
        const recovered = await runHandwork(["session", "recover", id, "--json"], {
          cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
        });
        expect(recovered.code).toBe(0);
        expect(recovered.stderr).toBe("");
        const result = JSON.parse(recovered.stdout);
        expect(result).toMatchObject({ kind: "session_recovery", source_id: id, status: "recovered" });
        expect(result.recovered_id).not.toBe(id);
        expect(provider.requests).toHaveLength(2);
        expect(savedFileHashes(source)).toEqual(before);
        const target = join(fixture.home, ".handwork", "sessions", result.recovered_id);
        if (damagedUsage || missingUsage) {
          const usage = JSON.parse(readFileSync(join(target, "usage-v2.json"), "utf8")).snapshot;
          expect(usage.billing).toBe("incomplete");
          expect(usage.api_duration_complete).toBe(false);
          expect(usage.wall_duration_complete).toBe(false);
          expect(usage.code_complete).toBe(false);
          expect(usage.incidents.length).toBeGreaterThan(0);
        }
        expect(JSON.parse(readFileSync(join(target, "session.json"), "utf8")).title).toBe(metadata.title);
        const targetEvents = readFileSync(join(target, "events.jsonl"), "utf8");
        expect(targetEvents.startsWith(prefix)).toBe(true);
        expect(targetEvents).not.toContain("CORRUPT_TAIL_MUST_NOT_REPLAY");
        const suffix = targetEvents.slice(prefix.length);
        if (checkpointedTurn) expect(JSON.parse(suffix).event).toEqual({ interrupted: expect.objectContaining({ reason: "failed" }) });
        else expect(suffix).toBe("");
        for (const [path, digest] of Object.entries(before)) {
          if (path.startsWith("tool-results/") || path.startsWith("logs/commands/")) {
            expect(savedFileHashes(target)[path]).toBe(digest);
          }
        }

        responses.push(
          fakeCodexToolCall("read-recovered", "read_tool_result", { request: { handle: stored.artifact_ref, query: "RESULT_RECOVERY_982" } }),
          fakeCodexFinalText("RECOVERED_CONTINUATION_SAVED"),
        );
        const tracePath = join(fixture.root, "continue.trace.log");
        const continued = await runHandwork(["ask", "--json", "--full-access", "--resume-id", result.recovered_id, "Read the retained result. Do not repeat completed commands."], {
          cwd: fixture.workspace,
          env: { ...providerEnv(fixture, provider), HANDWORK_TRACE_LOG: tracePath, HANDWORK_TRACE_SCOPES: "tool,session,agent" },
          timeoutMs: TIMEOUT,
        });
        expect(continued.code).toBe(0);
        expect(JSON.parse(continued.stdout)).toMatchObject({ output: "RECOVERED_CONTINUATION_SAVED", tool_calls: [{ name: "read_tool_result", status: "success" }] });
        expect(provider.requests).toHaveLength(4);
        const executionStarts = readFileSync(tracePath, "utf8").split("\n")
          .filter((line) => line.includes("[tool] event=execution_start "));
        expect(executionStarts).toHaveLength(1);
        expect(executionStarts[0]).toContain("call_id=read-recovered name=read_tool_result");
        const after = readFileSync(join(target, "events.jsonl"), "utf8").trimEnd().split("\n").map(JSON.parse);
        const readResult = after.find((record) => record.event.tool_result?.call_id === "read-recovered").event.tool_result;
        expect(readResult.status).toBe("success");
        expect(readFileSync(join(target, "tool-results", readResult.artifact_ref), "utf8")).toContain("RESULT_RECOVERY_982");
        expect(readFileSync(join(fixture.workspace, "effect.log"), "utf8")).toBe("ONCE_RECOVERY_731\n");
        expect(savedFileHashes(source)).toEqual(before);
        const inspected = await runHandwork(["session", "--id", result.recovered_id, "--json"], {
          cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
        });
        expect(inspected.code).toBe(0);
        expect(inspected.stderr).toBe("");
        expect(inspected.stdout).toContain("RECOVERED_CONTINUATION_SAVED");
      } finally {
        provider.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }

  for (const tail of ["", "invalid tail\n"]) {
    test(`current recovery excludes checkpoint splitting a call/result pair with tail=${tail.length > 0}`, async () => {
      const fixture = createFixture("handwork-session-current-cut-");
      const responses = [fakeShellRun("cut-call", "printf 'CUT_RESULT_619\\n'"), fakeCodexFinalText("CUT_SAVED")];
      const provider = startFakeCodex(responses);
      try {
        const created = await runHandwork(["ask", "--json", "--full-access", "Save one result."], {
          cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
        });
        expect(created.code).toBe(0);
        const id = JSON.parse(created.stdout).session_id;
        const source = join(fixture.home, ".handwork", "sessions", id);
        const eventPath = join(source, "events.jsonl");
        const prefix = readFileSync(eventPath, "utf8");
        const records = prefix.trimEnd().split("\n").map(JSON.parse);
        const callSeq = records.find((record) => record.event.tool_call).seq;
        appendFileSync(eventPath, JSON.stringify({ schema_version: 1, seq: records.at(-1).seq + 1, timestamp_ms: Date.now(), event: {
          context_checkpoint: { covers_through_seq: callSeq, summary: "INVALID_SPLIT_CHECKPOINT" },
        } }) + "\n" + tail);
        const before = savedFileHashes(source);
        const recovered = await runHandwork(["session", "recover", id, "--json"], {
          cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
        });
        expect(recovered.code).toBe(0);
        expect(recovered.stderr).toBe("");
        const result = JSON.parse(recovered.stdout);
        expect(result.status).toBe("recovered");
        const target = join(fixture.home, ".handwork", "sessions", result.recovered_id);
        expect(readFileSync(join(target, "events.jsonl"), "utf8")).toBe(prefix);
        expect(savedFileHashes(source)).toEqual(before);
        const inspected = await runHandwork(["session", "--id", result.recovered_id, "--json"], {
          cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
        });
        expect(inspected.code).toBe(0);
        expect(inspected.stderr).toBe("");
        expect(inspected.stdout).toContain("CUT_SAVED");
        responses.push(fakeCodexFinalText("CUT_CONTINUED"));
        const continued = await continueSession(fixture, provider, result.recovered_id);
        expect(continued.code).toBe(0);
        expect(JSON.parse(continued.stdout).output).toBe("CUT_CONTINUED");
        expect(provider.requests).toHaveLength(3);
        expect(savedFileHashes(source)).toEqual(before);
      } finally {
        provider.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }

  for (const damage of ["metadata", "private-child", "private-marker", "first-record", "missing-result", "changed-result"] as const) {
    test(`current conversation recovery refuses ${damage} without publishing a copy`, async () => {
      const fixture = createFixture("handwork-session-current-refusal-");
      const provider = startFakeCodex([
        fakeShellRun("retained-result", "printf 'REQUIRED_RESULT_619\\n'"),
        fakeCodexFinalText("RESULT_SAVED"),
      ]);
      try {
        const created = await runHandwork(["ask", "--json", "--full-access", "Save a result."], {
          cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
        });
        expect(created.code).toBe(0);
        const id = JSON.parse(created.stdout).session_id;
        const source = join(fixture.home, ".handwork", "sessions", id);
        const eventPath = join(source, "events.jsonl");
        const committed = readFileSync(eventPath, "utf8");
        if (damage === "metadata" || damage === "private-child") {
          const metadataPath = join(source, "session.json");
          const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
          if (damage === "metadata") metadata.id = "different-session";
          else metadata.subagent_child = true;
          writeFileSync(metadataPath, JSON.stringify(metadata), { mode: 0o600 });
        } else if (damage === "private-marker") {
          mkdirSync(join(source, "subagent"), { recursive: true, mode: 0o700 });
          writeFileSync(join(source, "subagent", "owner.json"), "{}", { mode: 0o600 });
          appendFileSync(eventPath, "invalid tail\n");
        } else if (damage === "first-record") {
          writeFileSync(eventPath, "[" + committed.slice(1), { mode: 0o600 });
        } else {
          appendFileSync(eventPath, "invalid tail\n");
          const record = committed.trimEnd().split("\n").map(JSON.parse)
            .find((frame) => frame.event.tool_result).event.tool_result;
          const artifactPath = join(source, "tool-results", record.artifact_ref);
          if (damage === "missing-result") rmSync(artifactPath);
          else {
            const bytes = readFileSync(artifactPath);
            bytes[0] ^= 1;
            writeFileSync(artifactPath, bytes);
          }
        }
        const before = savedFileHashes(source);
        const result = await runHandwork(["session", "recover", id, "--json"], {
          cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
        });
        expect(result.code).toBe(1);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout).code).toBe(damage === "private-child" || damage === "private-marker" ? "SessionNotFound" : "SessionRecoveryBoundaryInvalid");
        expect(savedFileHashes(source)).toEqual(before);
        const sessionRoot = join(fixture.home, ".handwork", "sessions");
        expect(readdirSync(sessionRoot).filter((name) => existsSync(join(sessionRoot, name, "session.json")))).toEqual([id]);
        expect(provider.requests).toHaveLength(2);
      } finally {
        provider.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }

  test.skipIf(!tmuxAvailable())("resume picker discovers a checkpoint from an unfinished first turn", async () => {
    const fixture = createFixture("handwork-session-first-checkpoint-");
    const provider = startFakeCodex([
      fakeCodexFinalText("FIRST_TURN_SAVED"),
      fakeCodexFinalText("CHECKPOINT_TURN_RECOVERED"),
    ]);
    let tui: TmuxSession | null = null;
    try {
      const sessionId = await createSavedSession(fixture, provider);
      const eventsPath = join(fixture.home, ".handwork", "sessions", sessionId, "events.jsonl");
      const checkpoint = [
        { user: { text: "unfinished first request", images: [], work_id: null } },
        { context_checkpoint: { covers_through_seq: 1, summary: "<context_handoff>FIRST_CHECKPOINT_FACT</context_handoff>" } },
      ].map((event, index) => JSON.stringify({
        schema_version: 1, seq: index + 1, timestamp_ms: Date.now(), event,
      })).join("\n") + "\n";
      writeFileSync(eventsPath, checkpoint, { mode: 0o600 });
      const listed = await runHandwork(["sessions", "--json"], {
        cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: TIMEOUT,
      });
      expect(listed.code).toBe(0);
      expect(JSON.parse(listed.stdout).sessions.map((entry: { id: string }) => entry.id))
        .toContain(sessionId);
      expect(JSON.parse(listed.stdout).sessions[0].history_len).toBe(0);
      expect(JSON.parse(listed.stdout).sessions[0]).not.toHaveProperty("has_checkpoint");
      expect(readFileSync(eventsPath, "utf8")).toBe(checkpoint);

      const stderrPath = join(fixture.root, "tui.stderr");
      tui = await TmuxSession.create({ cwd: fixture.workspace, env: providerEnv(fixture, provider), stderrPath });
      await tui.waitForComposer(TIMEOUT);
      await tui.sendText("/resume");
      await tui.waitForText("Create the first saved turn.", TIMEOUT);
      expect(readFileSync(eventsPath, "utf8")).toBe(checkpoint);
      await tui.sendKeys("Enter");
      await tui.waitForText("unfinished first request", TIMEOUT);
      await tui.waitForComposer(TIMEOUT);
      await tui.sendText("Continue after checkpoint.");
      await tui.waitForPane(() => readFileSync(eventsPath, "utf8").includes("CHECKPOINT_TURN_RECOVERED"), TIMEOUT);
      await tui.sendText("/quit");
      expect(await tui.waitForSessionEnd(TIMEOUT)).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[1]!.body).toContain("FIRST_CHECKPOINT_FACT");
    } finally {
      await tui?.kill();
      provider.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  test.skipIf(!tmuxAvailable())("latest resume ignores unrelated history and unfinished migration", async () => {
    const fixture = createFixture("handwork-continue-isolated-discovery-");
    const provider = startFakeCodex([
      fakeCodexFinalText("LOCAL_HISTORY_KEPT"),
      fakeCodexFinalText("CONTINUE_DISCOVERY_OK"),
    ]);
    let tui: TmuxSession | null = null;
    try {
      const id = await createSavedSession(fixture, provider);
      const sessions = join(fixture.home, ".handwork", "sessions");
      const unpublished = join(sessions, "unpublished");
      mkdirSync(unpublished, { mode: 0o700 });
      writeFileSync(join(unpublished, "session.lock"), "", { mode: 0o600 });
      const metadata = JSON.parse(readFileSync(join(sessions, id, "session.json"), "utf8"));
      const foreign = join(sessions, "foreign-history");
      mkdirSync(foreign, { mode: 0o700 });
      writeFileSync(join(foreign, "session.json"), JSON.stringify({
        ...metadata, id: "foreign-history", workspace_root: "/another-workspace",
      }), { mode: 0o600 });
      writeFileSync(join(foreign, "events.jsonl"), "UNRELATED_UNREADABLE_HISTORY\n", { mode: 0o600 });
      const fenced = join(sessions, "foreign-fenced");
      mkdirSync(fenced, { mode: 0o700 });
      writeFileSync(join(fenced, "session.json"), JSON.stringify({
        schema_version: 1, id: "foreign-fenced", created_at_ms: 1,
        updated_at_ms: Date.now(), workspace_root: "/another-workspace",
        conversation_language: "en", history_len: 0, history: [],
      }), { mode: 0o600 });
      writeFileSync(join(fenced, "authority.pending.json"), "pending", { mode: 0o600 });
      const foreignBefore = savedFileHashes(foreign);
      const fencedBefore = savedFileHashes(fenced);
      const stderrPath = join(fixture.root, "continue.stderr");
      tui = await TmuxSession.create({
        cmd: `${JSON.stringify(HANDWORK_BIN)} --resume-last`,
        cwd: fixture.workspace, env: providerEnv(fixture, provider), stderrPath,
      });
      await tui.waitForComposer(TIMEOUT);
      await tui.waitForText("LOCAL_HISTORY_KEPT", TIMEOUT);
      await tui.sendText("Continue the same conversation.");
      await tui.waitForText("CONTINUE_DISCOVERY_OK", TIMEOUT);
      await tui.waitForComposer(TIMEOUT);
      await tui.sendText("/quit");
      expect(await tui.waitForSessionEnd(TIMEOUT)).toBe(true);
      expect(readFileSync(stderrPath, "utf8")).toBe("");
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[1]!.body).toContain("LOCAL_HISTORY_KEPT");
      expect(readFileSync(join(sessions, id, "events.jsonl"), "utf8")).toContain("CONTINUE_DISCOVERY_OK");
      expect(savedFileHashes(foreign)).toEqual(foreignBefore);
      expect(savedFileHashes(fenced)).toEqual(fencedBefore);
    } finally {
      await tui?.kill();
      provider.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  

  

  

  

  for (const { target, fileName, fenced } of [
    { target: "event log", fileName: "events.jsonl", fenced: false },
    { target: "fenced legacy snapshot", fileName: "session.legacy.json", fenced: true },
  ]) {
    test.skipIf(process.platform === "win32")(`ask resume last rejects a FIFO ${target} promptly without writes`, async () => {
      const fixture = createFixture("handwork-session-fifo-");
      const provider = startFakeCodex([fakeCodexFinalText("FIFO_SOURCE_SAVED")]);
      try {
        const id = fenced ? "fenced-legacy-fifo" : await createSavedSession(fixture, provider);
        const source = join(fixture.home, ".handwork", "sessions", id);
        if (fenced) {
          mkdirSync(source, { recursive: true, mode: 0o700 });
          const snapshot = JSON.stringify({
            schema_version: 1, id, created_at_ms: 1, updated_at_ms: Date.now(),
            workspace_root: fixture.workspace, conversation_language: "en", history_len: 0, history: [],
          });
          writeFileSync(join(source, "session.json"), snapshot, { mode: 0o600 });
          writeFileSync(join(source, "session.legacy.json"), snapshot, { mode: 0o600 });
          writeFileSync(join(source, "authority.pending.json"), "pending", { mode: 0o600 });
        }
        const fifoPath = join(source, fileName);
        const before = savedFileHashes(source);
        delete before[fileName];
        rmSync(fifoPath);
        execFileSync("mkfifo", ["-m", "600", fifoPath]);
        const fifoBefore = lstatSync(fifoPath);
        expect(fifoBefore.isFIFO()).toBe(true);
        const namesBefore = readdirSync(source, { recursive: true }).sort();
        const result = await runHandwork(["ask", "--json", "--auto", "--resume", "last", "Never open the FIFO."], {
          cwd: fixture.workspace, env: providerEnv(fixture, provider), timeoutMs: 5_000,
        });
        expect(result.timedOut).toBe(false);
        expect(result.killSent).toBe(false);
        expect(result.code).toBe(1);
        expect(result.elapsedMs).toBeLessThan(5_000);
        expect(result.stdout + result.stderr).toContain("SessionPathUnsafe");
        expect(provider.requests).toHaveLength(fenced ? 0 : 1);
        expect(provider.classifierRequests).toHaveLength(0);
        expect(readdirSync(source, { recursive: true }).sort()).toEqual(namesBefore);
        const fifoAfter = lstatSync(fifoPath);
        expect(fifoAfter.isFIFO()).toBe(true);
        expect([fifoAfter.ino, fifoAfter.size, fifoAfter.mtimeMs, fifoAfter.ctimeMs])
          .toEqual([fifoBefore.ino, fifoBefore.size, fifoBefore.mtimeMs, fifoBefore.ctimeMs]);
        // Never hash/read the FIFO: retain the regular-file and directory evidence separately.
        for (const [path, digest] of Object.entries(before)) {
          expect(createHash("sha256").update(readFileSync(join(source, path))).digest("hex")).toBe(digest);
        }
        expect(readdirSync(join(fixture.home, ".handwork", "sessions"))).toEqual([id]);
      } finally {
        provider.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }

  test("latest resume discovers and repairs a partial final JSONL record", async () => {
    const fixture = createFixture("handwork-session-partial-record-");
    const provider = startFakeCodex([
      fakeCodexFinalText("FIRST_TURN_SAVED"),
      fakeCodexFinalText("PARTIAL_RECORD_RECOVERED"),
    ]);
    try {
      const sessionId = await createSavedSession(fixture, provider);
      const sessionDir = join(fixture.home, ".handwork", "sessions", sessionId);
      const eventsPath = join(sessionDir, "events.jsonl");
      const committed = readFileSync(eventsPath, "utf8");
      appendFileSync(eventsPath, '{"schema_version":1,"partial-tail"');

      const listed = await runHandwork(["sessions", "--json"], {
        cwd: fixture.workspace,
        env: providerEnv(fixture, provider),
        timeoutMs: TIMEOUT,
      });
      expect(listed.code).toBe(0);
      expect(listed.stderr).toBe("");
      expect(JSON.parse(listed.stdout).sessions.map((entry: { id: string }) => entry.id))
        .toContain(sessionId);
      expect(readFileSync(eventsPath, "utf8")).toBe(committed + '{"schema_version":1,"partial-tail"');

      const resumed = await continueSession(fixture, provider, sessionId, true);
      expect(resumed.code).toBe(0);
      expect(resumed.stderr).toBe("");
      expect(JSON.parse(resumed.stdout).session_id).toBe(sessionId);
      expect(JSON.parse(resumed.stdout).output).toBe("PARTIAL_RECORD_RECOVERED");
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[1]!.body).not.toContain("partial-tail");

      const repaired = readFileSync(eventsPath, "utf8");
      expect(repaired.startsWith(committed)).toBe(true);
      expect(repaired).not.toContain("partial-tail");
      const files = readdirSync(sessionDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
      expect(files).toEqual([
        "events.jsonl",
        "permissions.json",
        "session.json",
        "session.lock",
        "usage-v2.json",
      ]);
    } finally {
      provider.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, TIMEOUT);

  for (const partialNextRecord of [false, true]) {
    test(`writable resume truncates an unfinished turn with partial next record=${partialNextRecord}`, async () => {
      const fixture = createFixture("handwork-session-unfinished-turn-");
      const provider = startFakeCodex([
        fakeCodexFinalText("FIRST_TURN_SAVED"),
        fakeCodexFinalText("UNFINISHED_TURN_RECOVERED"),
      ]);
      try {
        const sessionId = await createSavedSession(fixture, provider);
        const eventsPath = join(
          fixture.home,
          ".handwork",
          "sessions",
          sessionId,
          "events.jsonl",
        );
        const committed = readFileSync(eventsPath, "utf8");
        const lines = committed.trimEnd().split("\n");
        const last = JSON.parse(lines[lines.length - 1]!);
        appendFileSync(eventsPath, JSON.stringify({
          schema_version: 1,
          seq: last.seq + 1,
          timestamp_ms: Date.now(),
          event: {
            user: {
              text: "DANGLING_USER_MUST_NOT_REPLAY",
              images: [],
              work_id: null,
            },
          },
        }) + "\n");
        if (partialNextRecord) appendFileSync(eventsPath, '{"schema_version":1,"event":');

        const resumed = await continueSession(fixture, provider, sessionId);
        expect(resumed.code).toBe(0);
        expect(resumed.stderr).toBe("");
        expect(JSON.parse(resumed.stdout).output).toBe("UNFINISHED_TURN_RECOVERED");
        expect(provider.requests).toHaveLength(2);
        expect(provider.requests[1]!.body).not.toContain(
          "DANGLING_USER_MUST_NOT_REPLAY",
        );
        expect(readFileSync(eventsPath, "utf8")).not.toContain(
          "DANGLING_USER_MUST_NOT_REPLAY",
        );
      } finally {
        provider.stop();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }, TIMEOUT);
  }

  test.each(["malformed", "oversized", "unreadable"])("committed-history corruption (%s) fails closed without rewriting JSONL", async (fault) => {
    const fixture = createFixture("handwork-session-middle-corruption-");
    const provider = startFakeCodex([
      fakeCodexFinalText("FIRST_TURN_SAVED"),
    ]);
    try {
      const sessionId = await createSavedSession(fixture, provider);
      const eventsPath = join(
        fixture.home,
        ".handwork",
        "sessions",
        sessionId,
        "events.jsonl",
      );
      const committed = readFileSync(eventsPath, "utf8");
      const corrupted = fault === "malformed"
        ? `[${committed.slice(1)}`
        : fault === "oversized" ? "x".repeat(64 * 1024 * 1024 + 1) + "\n" : committed;
      writeFileSync(eventsPath, corrupted, { mode: 0o600 });
      if (fault === "unreadable") chmodSync(eventsPath, 0);

      const detail = await runHandwork(
        ["session", "--id", sessionId, "--json"],
        {
          cwd: fixture.workspace,
          env: { HOME: fixture.home },
          timeoutMs: TIMEOUT,
        },
      );
      expect(detail.code).toBe(1);
      expect(detail.stderr).toBe("");
      expect(JSON.parse(detail.stdout)).toMatchObject({
        code: "SessionNotFound",
      });
      if (fault === "unreadable") chmodSync(eventsPath, 0o600);
      expect(readFileSync(eventsPath, "utf8")).toBe(corrupted);
      expect(provider.requests).toHaveLength(1);
    } finally {
      provider.stop();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, TIMEOUT);
});
