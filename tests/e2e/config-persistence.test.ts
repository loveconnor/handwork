import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDWORK_BIN, runHandwork } from "../evals/eval-helpers";
import {
  composerContains,
  FAKE_CODEX_MODEL,
  fakeCodexFinalText,
  fakeCodexToolCall,
  hasEmptyComposer,
  startFakeCodex,
  TmuxSession,
  tmuxAvailable,
} from "./tmux-helpers";

function tree(root: string, relative = ""): string[] {
  const path = relative ? join(root, relative) : root;
  const entries = readdirSync(path, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const child = relative ? join(relative, entry.name) : entry.name;
    result.push(child);
    if (entry.isDirectory()) result.push(...tree(root, child));
  }
  return result.sort();
}

