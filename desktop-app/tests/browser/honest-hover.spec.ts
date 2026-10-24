import { expect, test } from "@playwright/test";
for (const inset of [true, false])
  for (const light of [false, true]) {
    test(`Honest UI tab hover keeps geometry and selection (${inset ? "inset" : "classic"}, ${light ? "light" : "dark"})`, async ({
      page,
    }) => {
      await page.addInitScript(
        ({ inset }) =>
          localStorage.setItem("handwork.insetLayout", inset ? "1" : "0"),
        { inset },
      );
      await page.goto("/tests/browser/workspace-performance.html");
      await page.evaluate(
        (light) =>
          document.documentElement.classList.toggle("theme-light", light),
        light,
      );
      const inactive = page.locator("[data-title-tab]:visible").nth(1);
      const active = page.locator("[data-title-tab-active]:visible").first();
      await expect(inactive).toBeVisible();
      await page.mouse.move(1200, 850);
      const appearance = () =>
        inactive.evaluate((el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return {
            color: style.color,
            background: style.backgroundColor,
            opacity: style.opacity,
            width: rect.width,
            height: rect.height,
            transition: style.transitionDuration,
            easing: style.transitionTimingFunction,
          };
        });
      const before = await appearance();
      expect(before.background).toBe("rgba(0, 0, 0, 0)");
      expect(before.opacity).toBe("1");
      expect(before.transition).toContain("0.2s");
      await inactive.hover();
      await expect
        .poll(async () => (await appearance()).color)
        .not.toBe(before.color);
      const hovered = await appearance();
      expect(hovered.background).toBe(before.background);
      expect(hovered.opacity).toBe("1");
      expect(hovered.width).toBe(before.width);
      expect(hovered.height).toBe(before.height);
      await expect(active).toHaveAttribute("data-title-tab-active", "true");
      await expect(inactive).not.toHaveAttribute("data-title-tab-active");
      const activeBackground = await active.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      await active.hover();
      await expect
        .poll(() =>
          active.evaluate((el) => getComputedStyle(el).backgroundColor),
        )
        .toBe(activeBackground);
      await page.keyboard.press("Tab");
      await inactive.focus();
      await expect
        .poll(() =>
          inactive.evaluate((el) => getComputedStyle(el).outlineStyle),
        )
        .toBe("solid");
      expect(
        await inactive.evaluate((el) => getComputedStyle(el).outlineWidth),
      ).toBe("2px");
      await page
        .locator("[data-inset-title-bar]")
        .count()
        .then(async (count) => {
          if (count)
            await page
              .locator("[data-inset-title-bar]")
              .screenshot({
                path: `output/validation/honest-hover-tabs-${light ? "light" : "dark"}.png`,
                animations: "disabled",
              });
        });
    });
  }
test("Honest UI navigation has hover feedback and reduced motion is respected", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("handwork.insetLayout", "1"),
  );
  await page.goto("/tests/browser/workspace-performance.html");
  const newChat = page
    .getByRole("navigation", { name: "Chats", exact: true })
    .getByRole("button", { name: "New chat", exact: true });
  await expect(newChat).toBeVisible();
  await page.mouse.move(1200, 850);
  const background = await newChat.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  await newChat.hover();
  await expect
    .poll(() => newChat.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(background);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const tab = page.locator("[data-title-tab]:visible").nth(1);
  expect(
    await tab.evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
  expect(
    await newChat.evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
  await tab.hover();
  await page.mouse.down();
  expect(await tab.evaluate((el) => getComputedStyle(el).scale)).toBe("none");
  await page.mouse.up();
});
