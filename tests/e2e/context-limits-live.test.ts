import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HAS_SUBSCRIPTION, runHandwork } from "../evals/eval-helpers";

const LIVE_ENABLED = process.env.HANDWORK_E2E_REAL_API === "1";
const TIMEOUT = 180_000;
const MODEL = "openai/gpt-5";

describe.skipIf(!LIVE_ENABLED || !HAS_SUBSCRIPTION)("live source context limits", () => {
  
});
