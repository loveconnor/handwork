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
  const root = mkdtempSync(join(tmpdir(), "handwork-web-search-no-auth-"));
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

function expectNoSearchProgress(stderr: string) {
  expect(stderr).not.toContain("Searching ");
  expect(stderr).not.toContain("Found ");
}

describe("web_search permission progress", () => {
  test(
    "default ask emits no native search progress before authentication",
    async () => {
      const result = await runWithoutProviderAuth([
        "ask",
        "--auto",
        "search the web for current news",
      ]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("handwork needs a Codex subscription login for this model. Run handwork login codex.");
      expectNoSearchProgress(result.stderr);
    },
    TIMEOUT,
  );

  test(
    "help does not print the ordinary tool inventory",
    async () => {
      const result = await runHandwork(["--help"]);

      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("web_search");
    },
    TIMEOUT,
  );
});
