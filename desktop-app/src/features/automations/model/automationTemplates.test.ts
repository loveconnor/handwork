import { describe, expect, it } from "vitest";
import {
  AUTOMATION_TEMPLATE_CATEGORIES,
  AUTOMATION_TEMPLATES,
  templatesForCategory,
} from "./automationTemplates";

describe("automation templates", () => {
  it("keeps popular examples in their real category too", () => {
    const popular = templatesForCategory("popular");
    expect(popular.map((template) => template.id)).toEqual([
      "find-critical-bugs",
      "scan-vulnerabilities",
      "generate-docs",
      "add-test-coverage",
    ]);
    expect(templatesForCategory("review").some((t) => t.popular)).toBe(true);
    expect(templatesForCategory("security").some((t) => t.popular)).toBe(true);
  });

  it("covers every gallery category with at least one example", () => {
    for (const category of AUTOMATION_TEMPLATE_CATEGORIES) {
      expect(templatesForCategory(category.id).length).toBeGreaterThan(0);
    }
    expect(
      AUTOMATION_TEMPLATES.every((template) => template.prompt.trim()),
    ).toBe(true);
  });
});

it("contains only scheduled automation templates", () => {
  expect(AUTOMATION_TEMPLATES.every((t) => t.trigger.kind === "time")).toBe(
    true,
  );
});
