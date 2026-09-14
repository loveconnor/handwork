import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeCodexFinalText, fakeCodexToolCall, startFakeCodex } from "../tests/e2e/tmux-helpers";

test("signed macOS variants preserve the image flow and native resource accounting", async () => {
  const root = process.env.HANDWORK_SIGNED_COMPARE_DIR;
  const probe = process.env.HANDWORK_SIGNED_RESOURCE_PROBE;
  if (!root || !probe) throw new Error("signed comparison paths are required");
  const fixture = join(import.meta.dirname, "../tests/e2e/fixtures/mcp-modern-stdio.mjs");
  const model = "fixture/vision";
  const rows: Array<Record<string, number | string>> = [];
  writeFileSync(join(root, "memory-manifest.json"), JSON.stringify({
    fixture_sha256: new Bun.CryptoHasher("sha256").update(readFileSync(fixture)).digest("hex"),
    bun: Bun.version, model, samples_per_binary: 200, warmup_pairs: 3,
    boundary: "native handwork PID after decoded image reaches provider, before final response",
    accounting: "proc_pid_rusage; excludes the Bun provider and MCP helper",
    order: "alternating AB/BA with reversed equal-length lanes", timeout_ms: 20_000,
    claim_limit: "resource screen, not a heap-leak proof",
  }, null, 2));
  for (let round = -3; round < 200; round++) {
    for (const label of round % 2 === 0 ? ["control", "candidate"] : ["candidate", "control"]) {
      const dir = mkdtempSync(join(tmpdir(), "handwork-signed-memory-"));
      const cohort = Math.abs(Math.floor(round / 2)) % 2;
      const lane = (label === "candidate" ? 1 : 0) ^ cohort;
      const binary = join(root, `cohort-${cohort}`, `lane-${lane}`, "handwork");
      const profile = join(dir, "profile"), workspace = join(dir, "workspace");
      mkdirSync(join(profile, ".handwork"), { recursive: true });
      mkdirSync(workspace);
      writeFileSync(join(profile, ".handwork/settings.json"), "{}");
      writeFileSync(join(profile, ".handwork/mcp.json"), JSON.stringify({ mcp: { fixture: {
        type: "local", command: [process.execPath, fixture], enabled: true,
        environment: { HANDWORK_MCP_PROTOCOL_VERSION: "2026-07-28", HANDWORK_MCP_MODE: "image_result" },
      } } }));
      let childPid = 0;
      let sample: Record<string, number> | null = null;
      const provider = startFakeCodex([
        fakeCodexToolCall("image_select", "mcp_select_tool", { name: "mcp_fixture_echo" }),
        fakeCodexToolCall("image_call", "mcp_fixture_echo", { text: "screenshot" }),
        () => {
          const measured = Bun.spawnSync([probe, String(childPid)], { stdout: "pipe", stderr: "pipe" });
          expect(measured.exitCode, measured.stderr.toString()).toBe(0);
          sample = JSON.parse(measured.stdout.toString());
          return fakeCodexFinalText("Image result observed.");
        },
      ], { models: [{ id: model, type: "language", tags: ["tool-use", "vision", "file-input"] }] });
      try {
        const child = Bun.spawn([binary, "ask", "--json", "--auto", "--no-save", "Get an image from the fixture"], {
          cwd: workspace, stdin: "ignore", stdout: "pipe", stderr: "pipe",
          env: { PATH: process.env.PATH ?? "", TMPDIR: dir, LANG: "en_US.UTF-8", TZ: "UTC",
            HOME: profile, HANDWORK_AUTH_MODE: "host-managed", HANDWORK_AUTO_UPGRADE: "0", HANDWORK_SOUND: "0",
            HANDWORK_DISABLE_KEYCHAIN: "1", HANDWORK_SKIP_ONBOARDING: "1", HANDWORK_PERMISSION_MODE: "auto", HANDWORK_MODEL: model,
            HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`, HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
            HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl },
        });
        childPid = child.pid;
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        let code: number, stdout: string, stderr: string;
        try {
          [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) {
            child.kill("SIGKILL");
            await child.exited;
          }
        }
        expect(code!, stderr! || stdout!).toBe(0);
        expect(stderr!.trim().split("\n")).toEqual(["Selecting MCP tool mcp_fixture_echo", "MCP: mcp_fixture_echo"]);
        expect(JSON.parse(stdout!).output).toContain("Image result observed.");
        const parts = JSON.parse(provider.requests.at(-1)!.body).prompt.flatMap((message: any) => message.content ?? []);
        const result = parts.find((part: any) => part.type === "tool-result" && part.toolCallId === "image_call");
        expect(result.output.value.some((part: any) => part.type === "image-data" && part.mediaType === "image/png")).toBe(true);
        expect(sample).not.toBeNull();
        if (round >= 0) rows.push({ label, round, ...sample! });
        writeFileSync(join(root, "memory-results.json"), JSON.stringify(rows, null, 2));
      } finally { provider.stop(); rmSync(dir, { recursive: true, force: true }); }
    }
  }
  expect(rows).toHaveLength(400);
}, 180_000);
