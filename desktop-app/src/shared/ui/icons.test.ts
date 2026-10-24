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
  it("uses Honest UI logos or neutral Honest UI icons for every provider", () => {
    for (const harness of HARNESSES) {
      const html = renderToStaticMarkup(
        createElement(HarnessIcon, { harness }),
      );
      expect(html, harness).toContain("<svg");
      expect(html, harness).not.toContain("<img");
      expect(html, harness).toMatch(/data-honest-(?:logo|icon)=/);
    }
  });
});
