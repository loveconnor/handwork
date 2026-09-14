import { describe, expect, test } from "bun:test";
import { buildEvalProcessEnv, shouldLoadDotEnv } from "./eval-helpers";

describe("eval helpers", () => {
  test("passes the selected eval model to handwork through HANDWORK_MODEL", () => {
    const previous = process.env.HANDWORK_MODEL;
    process.env.HANDWORK_MODEL = "ambient/model";

    try {
      const env = buildEvalProcessEnv("/tmp/handwork-eval-home-test", "selected/model");

      expect(env.HANDWORK_MODEL).toBe("selected/model");
      expect(env.HOME).toBe("/tmp/handwork-eval-home-test");
      expect(env.NO_COLOR).toBe("1");
    } finally {
      if (previous === undefined) {
        delete process.env.HANDWORK_MODEL;
      } else {
        process.env.HANDWORK_MODEL = previous;
      }
    }
  });

  test("does not load repository dotenv files in a hermetic run", () => {
    expect(shouldLoadDotEnv({ HANDWORK_E2E_DISABLE_DOTENV: "1" })).toBe(false);
    expect(shouldLoadDotEnv({})).toBe(true);
  });
});
