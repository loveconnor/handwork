import { describe, expect, test } from "bun:test";
import {
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
  FAKE_CODEX_MODEL,
  fakeCodexFinalText,
  fakeCodexToolCall,
  startFakeCodex,
  type FakeCodexResponse,
} from "./tmux-helpers";

const TIMEOUT = 120_000;
const CONFIGURED_SANDBOX = process.platform === "darwin" ? "os" : "none";

type HandworkJson = {
  output: string;
  exit_code: number;
  tool_calls: Array<{ name: string; status: string }>;
};

function createIsolatedRoot(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const external = join(root, "external");
  mkdirSync(join(home, ".handwork"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(external, { recursive: true });
  return {
    root,
    home,
    workspace: realpathSync(workspace),
    external: realpathSync(external),
  };
}

function parseHandworkJson(result: { stdout: string; stderr: string; code: number | null }): HandworkJson {
  if (result.code !== 0) {
    throw new Error(`handwork exited ${result.code}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim()) as HandworkJson;
}

async function runWithFakeCodex(
  root: ReturnType<typeof createIsolatedRoot>,
  args: string[],
  responses: FakeCodexResponse[],
  env: Record<string, string> = {},
) {
  const provider = startFakeCodex(responses);
  try {
    const result = await runHandwork(args, {
      cwd: root.workspace,
      env: {
        HOME: root.home,
        HANDWORK_AUTH_MODE: "host-managed",

        ...env,
        HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
        HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
        HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: provider.chatUrl,
        HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${provider.baseUrl}/models`,
        HANDWORK_MODEL: FAKE_CODEX_MODEL,
        HANDWORK_AUTO_UPGRADE: "0",
      },
      timeoutMs: TIMEOUT,
    });
    return { provider, result };
  } finally {
    provider.stop();
  }
}

describe("external file permissions", () => {
  test(
    "handwork ask --yolo bypasses a configured write denial without a classifier request",
    async () => {
      const root = createIsolatedRoot("handwork-yolo-permissions-");
      try {
        const target = join(root.external, "yolo-write.txt");
        const tracePath = join(root.root, "permission-trace.log");
        const settingsPath = join(root.home, ".handwork", "settings.json");
        writeFileSync(
          settingsPath,
          JSON.stringify({
            permission_mode: "ask",
            sandbox: CONFIGURED_SANDBOX,
            yolo_acknowledged: false,
            permission: { edit: "deny" },
          }) + "\n",
        );

        const { provider, result } = await runWithFakeCodex(
          root,
          [
            "ask",
            "--json",
            "--no-save",
            "--yolo",
            `Use only the write_file tool to create ${target} with exactly this content: HANDWORK_E2E_YOLO.`,
          ],
          [
            fakeCodexToolCall("yolo_write_1", "write_file", {
              path: target,
              content: "HANDWORK_E2E_YOLO",
            }),
            fakeCodexFinalText("yolo write complete"),
          ],
          {
            HANDWORK_TRACE_LOG: tracePath,
            HANDWORK_TRACE_SCOPES: "permission",
          },
        );

        expect(result.stderr).toContain(
          "Full access enabled: handwork permission checks disabled",
        );
        const output = parseHandworkJson(result);
        expect(
          output.tool_calls.some(
            (call) => call.name === "write_file" && call.status === "success",
          ),
        ).toBe(true);
        expect(readFileSync(target, "utf8")).toBe("HANDWORK_E2E_YOLO");
        const trace = readFileSync(tracePath, "utf8");
        expect(trace).not.toContain("event=auto_review_start");
        expect(provider.classifierRequests).toHaveLength(0);
        expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
          permission_mode: "ask",
          sandbox: CONFIGURED_SANDBOX,
          yolo_acknowledged: true,
        });
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  test(
    "handwork ask reads external paths and exercises classifier and rule-gated writes",
    async () => {
      const root = createIsolatedRoot("handwork-file-permissions-");
      try {
        const readTarget = join(root.external, "read-fixture.txt");
        const classifiedTarget = join(root.external, "classified-write.txt");
        const allowedTarget = join(root.external, "allowed-write.txt");
        const tracePath = join(root.root, "permission-trace.log");
        writeFileSync(readTarget, "HANDWORK_E2E_EXTERNAL_READ\n");
        writeFileSync(classifiedTarget, "before");
        writeFileSync(join(root.home, ".handwork", "settings.json"), "{}");

        const { result: readResult } = await runWithFakeCodex(
          root,
          [
            "ask",
            "--json",
            "--no-save",
            "--auto",
            `Use only the read_file tool to read ${readTarget}, then reply with exactly the file content and nothing else.`,
          ],
          [
            fakeCodexToolCall("external_read_1", "read_file", { path: readTarget }),
            fakeCodexFinalText("HANDWORK_E2E_EXTERNAL_READ"),
          ],
        );
        const read = parseHandworkJson(readResult);
        expect(read.tool_calls).toContainEqual({ name: "read_file", status: "success" });
        expect(read.output).toContain("HANDWORK_E2E_EXTERNAL_READ");

        const { provider: classifiedProvider, result: classifiedResult } =
          await runWithFakeCodex(
            root,
            [
              "ask",
              "--json",
              "--no-save",
              "--auto",
              `Use only the write_file tool to overwrite ${classifiedTarget} with exactly this content: HANDWORK_E2E_EXTERNAL_CLASSIFIED.`,
            ],
            [
              fakeCodexToolCall("classified_write_1", "write_file", {
                path: classifiedTarget,
                content: "HANDWORK_E2E_EXTERNAL_CLASSIFIED",
              }),
              fakeCodexFinalText("classified write complete"),
            ],
            {
              HANDWORK_TRACE_LOG: tracePath,
              HANDWORK_TRACE_SCOPES: "permission",
            },
          );
        const trace = readFileSync(tracePath, "utf-8");
        expect(trace.match(/event=auto_review_start/g)).toHaveLength(1);
        expect(trace.match(/event=auto_review_result/g)).toHaveLength(1);
        expect(trace).toContain("event=auto_review_result tool_name=write_file decision=clear");
        expect(classifiedProvider.classifierRequests).toHaveLength(1);
        const classified = parseHandworkJson(classifiedResult);
        expect(classified.tool_calls).toContainEqual({ name: "write_file", status: "success" });
        expect(readFileSync(classifiedTarget, "utf-8")).toBe("HANDWORK_E2E_EXTERNAL_CLASSIFIED");

        writeFileSync(
          join(root.home, ".handwork", "settings.json"),
          JSON.stringify({
            permission: {
              edit: {
                [`${root.external}/**`]: "allow",
              },
            },
          }),
        );

        const { provider: allowedProvider, result: allowedResult } = await runWithFakeCodex(
          root,
          [
            "ask",
            "--json",
            "--no-save",
            "--auto",
            `Use only the write_file tool to create ${allowedTarget} with exactly this content: HANDWORK_E2E_EXTERNAL_ALLOWED.`,
          ],
          [
            fakeCodexToolCall("allowed_write_1", "write_file", {
              path: allowedTarget,
              content: "HANDWORK_E2E_EXTERNAL_ALLOWED",
            }),
            fakeCodexFinalText("allowed write complete"),
          ],
        );
        const allowed = parseHandworkJson(allowedResult);
        expect(allowed.tool_calls).toContainEqual({ name: "write_file", status: "success" });
        expect(readFileSync(allowedTarget, "utf-8")).toBe("HANDWORK_E2E_EXTERNAL_ALLOWED");
        expect(allowedProvider.classifierRequests).toHaveLength(0);
      } finally {
        rmSync(root.root, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
