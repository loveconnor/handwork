import { expect, test } from "@playwright/test";

test("composer text and native caret share the same position and typography", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto("/tests/browser/workspace-performance.html?empty");
  const textarea = page.locator("textarea.composer-field:visible").first();
  await textarea.fill("Teach me\nsomething new");
  const geometry = await textarea.evaluate((el) => {
    const highlight = el.parentElement!.querySelector(".composer-highlight")!;
    const input = getComputedStyle(el);
    const overlay = getComputedStyle(highlight);
    return {
      offset:
        el.getBoundingClientRect().top - highlight.getBoundingClientRect().top,
      input: [
        input.fontFamily,
        input.fontSize,
        input.lineHeight,
        input.paddingTop,
        input.paddingLeft,
      ],
      overlay: [
        overlay.fontFamily,
        overlay.fontSize,
        overlay.lineHeight,
        overlay.paddingTop,
        overlay.paddingLeft,
      ],
    };
  });
  expect(geometry.offset).toBe(0);
  expect(geometry.input).toEqual(geometry.overlay);
  await expect(
    page
      .getByRole("navigation", { name: "Chats", exact: true })
      .getByRole("button", { name: "New project", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("composer-caret-aligned.png"),
    animations: "disabled",
  });
});
