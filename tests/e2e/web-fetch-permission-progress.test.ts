import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHandwork } from "../evals/eval-helpers";

const TIMEOUT = 15_000;
const NO_PROVIDER_AUTH = {


  HANDWORK_DISABLE_KEYCHAIN: "1",
};

async function runWithoutProviderAuth(args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "handwork-web-fetch-no-auth-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(workspace);
  try {
    return await runHandwork(args, {
      cwd: workspace,
      env: { ...NO_PROVIDER_AUTH, HOME: home },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectNoFetchProgress(stderr: string) {
  expect(stderr).not.toContain("Fetching ");
  expect(stderr).not.toContain("Converting ");
  expect(stderr).not.toContain("Extracting ");
}

describe("web_fetch permission progress", () => {
  test(
    "default ask emits no native fetch progress before authentication",
    async () => {
      const result = await runWithoutProviderAuth([
        "ask",
        "--auto",
        "fetch https://example.com/ and summarize it",
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("handwork needs a Codex subscription login for this model. Run handwork login codex.");
      expectNoFetchProgress(result.stderr);
    },
    TIMEOUT,
  );

});
