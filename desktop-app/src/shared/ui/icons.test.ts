import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessIcon } from "../../features/sessions/ui/HarnessIcon";
import { HARNESSES } from "../../features/sessions/model/session";
import { FilePlus, FoldVertical, UnfoldVertical } from "./icons";
const SRC = fileURLToPath(new URL("../..", import.meta.url));
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : /\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")
        ? [path]
        : [];
  });
}
describe("Honest UI artwork", () => {
  it("does not load legacy icon packs or provider artwork", () => {
    const violations = sources(SRC).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return /["'](?:@hugeicons\/|react-material-icon-theme|[^"']*assets\/providers\/)/.test(
        source,
      )
        ? [relative(SRC, file)]
        : [];
    });
    expect(violations).toEqual([]);
  });
  it("keeps stroke icons accessible and compatible with the app icon API", () => {
    for (const Icon of [FoldVertical, UnfoldVertical, FilePlus]) {
      const html = renderToStaticMarkup(
        createElement(Icon, {
          size: 18,
          strokeWidth: 1.5,
          className: "size-4",
        }),
      );
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('stroke-width="1.5"');
      expect(html).toContain('width="18"');
    }
  });
  it("uses the upstream provider logo for shared-harness models", () => {
    for (const [provider, brand] of Object.entries({
      ollama: "ollama",
      ollama_cloud: "ollama",
      opencode: "opencode",
      "opencode-go": "opencode",
      "opencode-zen": "opencode",
      deepseek: "deepseek",
      anthropic: "anthropic",
      openai: "openai",
      "github-copilot": "githubcopilot",
      "google-antigravity": "antigravity",
      "google-gemini-cli": "geminicli",
      "lm-studio": "lmstudio",
      "openai-codex": "openai",
      openrouter: "openrouter",
      xai: "xai",
    })) {
      const html = renderToStaticMarkup(
        createElement(HarnessIcon, { harness: "handwork", provider }),
      );
      expect(html, provider).toContain(`data-provider-logo="${brand}"`);
      expect(html, provider).toContain("<svg");
      expect(html, provider).toContain("<path");
      expect(html, provider).not.toContain("mask:");
    }
  });
  it("uses Honest UI artwork with LobeHub marks for missing provider brands", () => {
    for (const harness of HARNESSES) {
      const html = renderToStaticMarkup(
        createElement(HarnessIcon, { harness }),
      );
      expect(html, harness).not.toContain("<img");
      if (
        [
          "opencode",
          "antigravity",
          "hermes",
          "devin",
          "pi",
          "omp",
          "fx",
        ].includes(harness)
      ) {
        expect(html, harness).toContain(`data-provider-logo="${harness}"`);
        expect(html, harness).toContain("<svg");
        expect(html, harness).toContain("<path");
        expect(html, harness).not.toContain("mask:");
      } else {
        expect(html, harness).toContain("<svg");
        expect(html, harness).toMatch(/data-honest-(?:logo|icon)=/);
      }
    }
  });
});
