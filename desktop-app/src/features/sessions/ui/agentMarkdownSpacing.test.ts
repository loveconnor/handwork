// @vitest-environment happy-dom
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMarkdown } from "./AgentMarkdown";

/** Verify Honest Prose flow against Streamdown's actual block wrappers. */
// happy-dom rewrites import.meta.url, so resolve from the vitest root instead.
const CSS_PATH = resolve(process.cwd(), "src/styles/index.css");

const SAMPLE = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";

function renderAgentMarkdown(sample = SAMPLE): string {
  return renderToStaticMarkup(createElement(AgentMarkdown, { text: sample }));
}

type Rule = { selectors: string[]; body: string };

function splitSelectors(selector: string): string[] {
  let depth = 0,
    start = 0;
  const parts: string[] = [];
  for (let i = 0; i < selector.length; i++) {
    if (selector[i] === "(") depth++;
    else if (selector[i] === ")") depth--;
    else if (selector[i] === "," && depth === 0) {
      parts.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts;
}

function cssRules(): Rule[] {
  const css = [
    CSS_PATH,
    resolve(process.cwd(), "src/styles/honest-prose.css"),
    resolve(process.cwd(), "src/styles/markdown-prose.css"),
  ]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({
      selectors: splitSelectors(match[1]),
      body: match[2],
    });
  }
  return rules;
}

type Side = "top" | "bottom";

/** The margin index.css ends up declaring on one side of `el`, or null. */
function declaredMargin(el: Element, side: Side): string | null {
  const longhand = side === "top" ? "margin-top" : "margin-bottom";
  const logical = side === "top" ? "margin-block-start" : "margin-block-end";
  let value: string | null = null;

  for (const rule of cssRules()) {
    const matches = rule.selectors.some((selector) => {
      try {
        return el.matches(selector.replace(/\s+/g, " "));
      } catch {
        return false;
      }
    });
    if (!matches) continue;

    for (const declaration of rule.body.split(";")) {
      const [rawProperty, rawValue] = declaration.split(":");
      if (!rawValue) continue;
      const property = rawProperty.trim();
      const parts = rawValue.trim().split(/\s+/);
      if (property === longhand || property === logical) value = parts[0];
      else if (property === "margin-block")
        value = side === "top" ? parts[0] : (parts[1] ?? parts[0]);
      else if (property === "margin")
        value = side === "top" ? parts[0] : (parts[2] ?? parts[0]);
    }
  }
  return value;
}

function isZero(margin: string | null): boolean {
  return margin === null || /^0[a-z%]*$/.test(margin);
}

describe("agent-markdown Tailwind sources", () => {
  it("resolves every package source relative to the stylesheet", () => {
    const css = readFileSync(CSS_PATH, "utf8");
    const sources = [...css.matchAll(/@source\s+"([^"]+)"/g)].map(
      ([, source]) => source,
    );

    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      const directory = dirname(resolve(dirname(CSS_PATH), source));
      expect(existsSync(directory), `${source} should resolve`).toBe(true);
      expect(
        readdirSync(directory).some((entry) => entry.endsWith(".js")),
        `${source} should match package JavaScript`,
      ).toBe(true);
    }
  });
});

describe("agent-markdown paragraph spacing", () => {
  it("wraps each block in a real block box with no margin of its own", () => {
    document.body.innerHTML = renderAgentMarkdown();
    const root = document.querySelector(".agent-markdown")!;
    const paragraphs = [...root.querySelectorAll("p")];

    expect(root.className).toContain("space-y-4");
    expect(paragraphs).toHaveLength(3);
    for (const paragraph of paragraphs) {
      const wrapper = paragraph.parentElement!;
      // #496: a display:contents wrapper lets WebKit's triple-click run past
      // the block to the end of the reply.
      expect(wrapper.getAttribute("style") ?? "").not.toContain("contents");
      expect(wrapper.getAttribute("dir")).toBe("ltr");
      expect(wrapper.className).toBe("agent-markdown-block");
      expect(wrapper.parentElement).toBe(root);
      expect(declaredMargin(wrapper, "top")).toBe("0");
      expect(declaredMargin(wrapper, "bottom")).toBe("0");
    }
  });

  it("leaves a gap between consecutive paragraphs and none after the last", () => {
    document.body.innerHTML = renderAgentMarkdown();
    const paragraphs = [
      ...document.querySelectorAll<HTMLElement>(".agent-markdown p"),
    ];

    paragraphs.forEach((paragraph, index) => {
      const above = declaredMargin(paragraph, "top");
      const below = declaredMargin(paragraph, "bottom");

      if (index > 0) {
        const previousBelow = declaredMargin(paragraphs[index - 1], "bottom");
        expect(above, "expected the full gap between paragraphs").toBe(
          "var(--_flow)",
        );
        expect(isZero(previousBelow)).toBe(true);
      } else {
        expect(isZero(above), "no gap above the first paragraph").toBe(true);
      }

      if (index === paragraphs.length - 1) {
        expect(isZero(below), "no gap after the last paragraph").toBe(true);
      }
    });
  });

  it("leaves a gap between paragraphs nested inside a blockquote", () => {
    document.body.innerHTML = renderAgentMarkdown(
      "> First line\n>\n> Second line\n>\n> Third line",
    );
    const blockquote = document.querySelector<HTMLElement>(
      '.agent-markdown [data-streamdown="blockquote"]',
    )!;
    const paragraphs = [...blockquote.querySelectorAll<HTMLElement>("p")];

    expect(paragraphs).toHaveLength(3);
    paragraphs.forEach((paragraph, index) => {
      expect(paragraph.parentElement).toBe(blockquote);
      const above = declaredMargin(paragraph, "top");
      if (index === 0) expect(isZero(above)).toBe(true);
      else expect(above).toBe("var(--_flow)");
      expect(isZero(declaredMargin(paragraph, "bottom"))).toBe(true);
    });
  });

  it("uses Honest Prose flow for lists", () => {
    document.body.innerHTML = renderAgentMarkdown(
      "Intro.\n\n- First\n- Second\n\nMore context.\n\n1. First\n2. Second",
    );
    const lists = [
      ...document.querySelectorAll<HTMLElement>(
        '.agent-markdown [data-streamdown="unordered-list"], .agent-markdown [data-streamdown="ordered-list"]',
      ),
    ];

    expect(lists).toHaveLength(2);
    for (const list of lists) {
      expect(declaredMargin(list, "top")).toBe("var(--_flow)");
      expect(isZero(declaredMargin(list, "bottom"))).toBe(true);
    }
  });

  it("does not add a gap before the first visible block", () => {
    document.body.innerHTML = renderAgentMarkdown("\n\nFirst paragraph.");
    const paragraph = document.querySelector<HTMLElement>(".agent-markdown p")!;

    expect(paragraph.parentElement?.previousElementSibling).toBeTruthy();
    expect(isZero(declaredMargin(paragraph, "top"))).toBe(true);
  });
});
