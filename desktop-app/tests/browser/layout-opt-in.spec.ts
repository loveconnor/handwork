import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1300, height: 900 } });

async function openAppearance(page: Page) {
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await page.keyboard.press(`${modifier}+,`);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
}

test("defaults to inset with projects and Settings reachable without projects", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/browser/workspace-performance.html?empty");
  await expect(page.getByRole("status", { name: /Try the .*layout/ })).toHaveCount(0);

  const sidebar = page.locator(".inset-sidebar");
  const toggle = page.getByRole("button", { name: /^Toggle Sidebar/ });
  await expect(sidebar).toBeVisible();
  await expect(
    sidebar.getByRole("button", { name: "New chat", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "How can I help?" })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("new-layout-no-projects.png"),
  });

  await toggle.click();
  await page.mouse.move(700, 400);
  await expect(sidebar).toHaveCount(0);
  await toggle.click();
  await expect(sidebar).toBeVisible();

  await page.reload();
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole("button", { name: /^Settings/ }).click();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  const layout = page.getByRole("switch", { name: "Inset layout", exact: true });
  await expect(layout).toBeChecked();
  await layout.click();
  await expect(page.locator(".inset-shell")).toHaveCount(0);
  await expect(layout).not.toBeChecked();
});

test("opens the first project from a collapsed projectless sidebar", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("handwork.insetLayout", "1");
    localStorage.setItem("handwork.sessionSidebarOpen", "0");
  });
  await page.goto("/tests/browser/workspace-performance.html?empty");
  const sidebar = page.locator(".inset-sidebar");
  await page.getByRole("button", { name: /^Toggle Sidebar/ }).click();
  await expect(sidebar).toBeVisible();
  await page.evaluate(() => {
    const fixture = window as unknown as {
      workspaceInvoke: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
    };
    const base = fixture.workspaceInvoke;
    fixture.workspaceInvoke = (command, args) => {
      if (command === "plugin:dialog|open")
        return Promise.resolve(["/fixture/first-project"]);
      if (command === "session_list_by_project") return Promise.resolve([]);
      return base(command, args);
    };
  });
  const modifier = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control");
  await page.keyboard.press(`${modifier}+o`);
  await expect(
    sidebar.getByText("No project folder", { exact: true }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "first-project menu", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".inset-shell")).toBeVisible();
});

test("starts inset by default and switches back without changing glass", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem("handwork.insetGlass", "0");
  });
  await page.goto("/tests/browser/workspace-performance.html");
  const notice = page.getByRole("status", { name: /Try the .*layout/ });
  expect(await page.evaluate(() => localStorage.getItem("handwork.insetLayout"))).toBeNull();
  await expect(page.locator(".inset-shell")).toBeVisible();
  await expect(notice).toHaveCount(0);
  await expect(
    page.locator('[data-session-drop="workspace-session-0"]'),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("new-layout.png") });

  await page.reload();
  await expect(page.locator(".inset-shell")).toBeVisible();
  await expect(notice).toHaveCount(0);
  await openAppearance(page);
  const resizer = page.getByRole("separator", {
    name: "Resize project sidebar",
    exact: true,
  });
  await resizer.hover();
  await expect(resizer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(resizer).toHaveCSS("cursor", "col-resize");
  const width = Number(await resizer.getAttribute("aria-valuenow"));
  const edge = await resizer.boundingBox();
  await page.mouse.move(edge!.x + edge!.width / 2, edge!.y + 100);
  await page.mouse.down();
  await expect(resizer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.mouse.move(edge!.x + edge!.width / 2 + 40, edge!.y + 100, {
    steps: 4,
  });
  await expect(resizer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await page.mouse.up();
  await expect
    .poll(async () => Number(await resizer.getAttribute("aria-valuenow")))
    .toBeGreaterThan(width);
  await expect(resizer).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(
    page.getByRole("switch", { name: "Transparent window", exact: true }),
  ).not.toBeChecked();
  const layout = page.getByRole("switch", { name: "Inset layout", exact: true });
  await expect(layout).toBeChecked();
  await layout.click();
  await expect(layout).not.toBeChecked();
  await expect(page.locator(".inset-shell")).toHaveCount(0);
  await resizer.hover();
  await expect(resizer).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(
    await page.evaluate(() => localStorage.getItem("handwork.insetGlass")),
  ).toBe("0");

  await page.reload();
  await expect(
    page.locator('[data-session-drop="workspace-session-0"]'),
  ).toBeVisible();
  await expect(page.locator(".inset-shell")).toHaveCount(0);
  await expect(notice).toHaveCount(0);
});

test("preserves an explicit classic layout and allows switching in Settings", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("handwork.insetLayout", "0"));
  await page.goto("/tests/browser/workspace-performance.html");
  const notice = page.getByRole("status", { name: /Try the .*layout/ });
  await expect(notice).toHaveCount(0);
  await expect(page.locator(".inset-shell")).toHaveCount(0);
  await page.reload();
  await expect(
    page.locator('[data-session-drop="workspace-session-0"]'),
  ).toBeVisible();
  await expect(notice).toHaveCount(0);
  await openAppearance(page);
  const layout = page.getByRole("switch", { name: "Inset layout", exact: true });
  await expect(layout).not.toBeChecked();
  await layout.click();
  await expect(layout).toBeChecked();
  await expect(page.locator(".inset-shell")).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test("keeps the classic workspace after turning off the new layout and leaving Settings", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("handwork.insetLayout", "1");
  });
  await page.goto("/tests/browser/workspace-performance.html");
  await expect(page.locator(".inset-shell")).toBeVisible({ timeout: 15_000 });

  await openAppearance(page);
  const layout = page.getByRole("switch", { name: "Inset layout", exact: true });
  await layout.click();
  await expect(layout).not.toBeChecked();
  await page.keyboard.press("Escape");

  await expect(layout).toHaveCount(0);
  await expect(
    page.locator('[data-session-drop="workspace-session-0"]'),
  ).toBeVisible();
  await expect(page.locator(".inset-shell")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveClass(/layout-inset/);
  await expect(page.locator(".inset-rail-host")).toHaveCount(0);

  await openAppearance(page);
  await expect(layout).not.toBeChecked();
});
