import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1300, height: 900 } });

test("keeps only the command-palette search and the automation tab", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() =>
    localStorage.setItem("handwork.insetLayout", "1"),
  );
  await page.goto("/tests/browser/workspace-performance.html");
  await page.locator(".inset-shell").waitFor();
  await page.evaluate(() => {
    const native = (window as any).__TAURI_INTERNALS__;
    const original = native.invoke;
    native.invoke = (command: string, args: unknown) =>
      [
        "automations_list",
        "automation_runs_list",
        "automation_runs_recover",
      ].includes(command)
        ? Promise.resolve([])
        : original(command, args);
  });
  const nav = page.getByRole("navigation", { name: "Views" });
  for (const view of ["search", "inbox", "notes"])
    await expect(
      nav.getByRole("button", { name: new RegExp(`^${view}`, "i") }),
    ).toHaveCount(0);
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await page.keyboard.press(`${modifier}+k`);
  const prompt = page.getByPlaceholder("Go to File (type > for commands)");
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveValue(">");
  await expect(page.locator("[data-app-search]")).toHaveCount(0);
  await expect(
    page.locator('[data-title-tab-id="app-view:search"]'),
  ).toHaveCount(0);
  await page.screenshot({ path: "output/validation/command-palette-only.png" });
  await page.keyboard.press("Escape");
  await expect(prompt).not.toBeVisible();
  await nav.getByRole("button", { name: /^automations/i }).click();
  await expect(page.locator("[data-app-automations]")).toBeVisible();
  await page.screenshot({ path: "output/validation/command-palette-only.png" });
  expect(errors).toEqual([]);
});
