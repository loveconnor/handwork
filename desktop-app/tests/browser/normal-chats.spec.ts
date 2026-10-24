import { expect, test } from "@playwright/test";
for (const inset of [true, false])
  test(`standalone chats stay separate from projects (${inset ? "inset" : "classic"})`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(
      ({ inset }) =>
        localStorage.setItem("handwork.insetLayout", inset ? "1" : "0"),
      { inset },
    );
    await page.goto("/tests/browser/workspace-performance.html");
    await expect(
      page.locator('[data-slot="handwork-brand"]:visible'),
    ).toHaveText("Handwork");
    await expect(
      page.locator(
        '[aria-label="Development build"], [title="Development build"]',
      ),
    ).toHaveCount(0);
    if (inset) {
      const brand = await page
        .locator('[data-sidebar-header] [data-slot="handwork-brand"]:visible')
        .boundingBox();
      expect(brand).not.toBeNull();
      expect(brand!.y).toBeLessThan(90);
      expect(brand!.x).toBeLessThan(20);
    }
    const nav = page.getByRole("navigation", { name: "Chats", exact: true });
    await nav.getByRole("button", { name: "New chat", exact: true }).click();
    await expect(
      page.locator('textarea[placeholder="Message Handwork…"]:visible'),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Handwork Select model", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Handwork default", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("How can I help?", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add files", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Add files or choose a mode",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Session 1", { exact: true }).first(),
    ).not.toBeVisible();
    await expect(page.locator("[data-sessions-empty]:visible")).toBeVisible();
    await expect(
      page.locator("[data-sessions-empty] svg, [data-sessions-empty] img"),
    ).toHaveCount(0);
    const modifier = await page.evaluate(() =>
      /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
    );
    await page.keyboard.press(`${modifier}+n`);
    await expect(
      page.locator('textarea[placeholder="Message Handwork…"]:visible'),
    ).toBeVisible();
    await page.screenshot({
      path: `output/validation/normal-chats-${inset ? "inset" : "classic"}.png`,
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  });
test("fresh startup opens a normal chat without a project", async ({
  page,
}) => {
  await page.goto("/tests/browser/workspace-performance.html?empty");
  await expect(
    page.locator('textarea[placeholder="Message Handwork…"]:visible'),
  ).toBeVisible();
  await expect(
    page.getByText("How can I help?", { exact: true }),
  ).toBeVisible();
});

test("opens saved chat history after reload and returns from a project", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    localStorage.setItem("handwork.insetLayout", "1");
    if (!localStorage.getItem("fixture.chatRows"))
      localStorage.setItem(
        "fixture.chatRows",
        JSON.stringify([
          [
            "saved-chat",
            {
              id: "saved-chat",
              cwd: "/home/fixture",
              harness: "handwork",
              model: "",
              modelSettings: {},
              runtimeMode: "supervised",
              title: "Understanding eclipses",
              createdAt: Date.now(),
              updatedAt: Date.now(),
              blocks: [
                { id: "q", role: "user", text: "What is an eclipse?" },
                {
                  id: "a",
                  role: "assistant",
                  text: "An eclipse happens when one body blocks another.",
                },
              ],
            },
          ],
        ]),
      );
  });
  await page.goto("/tests/browser/workspace-performance.html");
  const nav = page.getByRole("navigation", { name: "Chats", exact: true });
  await nav.getByRole("button", { name: "Chats", exact: true }).click();
  await page.getByText("Understanding eclipses", { exact: true }).click();
  await expect(
    page.getByText("What is an eclipse?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("An eclipse happens when one body blocks another.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "project", exact: true }).click();
  await expect(
    page.getByText("Session 1", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Understanding eclipses", { exact: true }),
  ).toHaveCount(0);
  await nav.getByRole("button", { name: "Chats", exact: true }).click();
  await expect(
    page.getByText("What is an eclipse?", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await nav.getByRole("button", { name: "Chats", exact: true }).click();
  await page.getByText("Understanding eclipses", { exact: true }).click();
  await expect(
    page.getByText("What is an eclipse?", { exact: true }),
  ).toBeVisible();
});
