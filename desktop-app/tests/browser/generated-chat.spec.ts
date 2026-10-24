import { expect, test } from "@playwright/test";

test("normal chats render interactive forms and send their values back to chat", async ({
  page,
}) => {
  await page.goto("/tests/browser/generated-chat.html");
  await page.getByRole("textbox", { name: "Destination" }).fill("Paris");
  await page.getByRole("combobox", { name: "Transport" }).click();
  const option = page.getByRole("option", { name: "Train", exact: true });
  await expect(option).toBeVisible();
  expect(await option.evaluate((el) => getComputedStyle(el).color)).not.toBe(
    "rgba(0, 0, 0, 0)",
  );
  await option.click();
  await page.getByRole("button", { name: "Plan trip" }).click();
  await expect(page.getByTestId("sent")).toContainText("Plan my trip");
  await expect(page.getByTestId("sent")).toContainText(
    '"destination":{"value":"Paris"}',
  );
  await expect(page.getByTestId("sent")).toContainText('"source":"trip form"');
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("interactive-chat.png"),
  });
});
test("project chats keep honestai examples as code", async ({ page }) => {
  await page.goto("/tests/browser/generated-chat.html?project");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.locator("pre").first()).toContainText("root = Stack");
});

test("normal chats render the playground's charts and tables", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tests/browser/generated-chat.html?chart");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Month" })).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: test.info().outputPath("interactive-chart.png"),
  });
});

for (const theme of ["dark", "light"]) {
  test(`generated replies use HonestUI components and styles in ${theme} mode`, async ({
    page,
  }) => {
    await page.addInitScript((theme) => {
      localStorage.setItem("handwork.colorScheme", theme);
      document.addEventListener("DOMContentLoaded", () => {
        document.documentElement.classList.toggle(
          "theme-light",
          theme === "light",
        );
      });
    }, theme);
    await page.goto("/tests/browser/generated-chat.html");
    const button = page.getByRole("button", { name: "Plan trip" });
    await expect(page.locator(".generated-chat-ui")).toHaveAttribute(
      "data-theme",
      theme,
    );
    await expect(button).toHaveAttribute("data-slot", "button");
    await expect(button).toHaveCSS("border-radius", "4px");
    await expect(button).toHaveCSS("padding-left", "12px");
    await expect(button).toHaveCSS("padding-top", "8px");
    const styles = await button.evaluate((el) => {
      const s = getComputedStyle(el);
      const probe = document.createElement("span");
      probe.style.backgroundColor =
        "var(--hui-color-background-accent-emphasis-hover)";
      el.appendChild(probe);
      const hover = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        hover,
        background: s.backgroundColor,
        shadow: s.boxShadow,
        transition: s.transitionDuration,
      };
    });
    expect(styles.shadow).not.toBe("none");
    expect(styles.transition).not.toBe("0s");
    expect(styles.background).not.toBe("rgba(0, 0, 0, 0)");
    await button.hover();
    await expect(button).toHaveCSS("background-color", styles.hover);
    await page.getByRole("combobox", { name: "Transport" }).click();
    const dropdown = page.locator("[data-slot=select-content]");
    await expect(dropdown).toHaveCSS("border-radius", "4px");
    const popup = await dropdown.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        background: s.backgroundColor,
        border: s.borderTopStyle,
        shadow: s.boxShadow,
      };
    });
    expect(popup.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(popup.border).toBe("solid");
    expect(popup.shadow).not.toBe("none");
    await page.screenshot({
      path: test.info().outputPath(`honestui-${theme}.png`),
    });
  });
}

for (const theme of ["light", "dark"]) {
  for (const kind of ["line", "chart"]) {
    test(`${kind} charts paint the playground palette in ${theme} mode`, async ({
      page,
    }) => {
      await page.addInitScript((theme) => {
        localStorage.setItem("handwork.colorScheme", theme);
        document.addEventListener("DOMContentLoaded", () => {
          document.documentElement.classList.toggle(
            "theme-light",
            theme === "light",
          );
        });
      }, theme);
      await page.goto(`/tests/browser/generated-chat.html?${kind}`);
      const chart = page.locator("[data-chart]").first();
      await expect(chart).toBeVisible();
      // Inspect the painted series. Missing CSS variables used to yield only
      // neutral gray pixels even though a canvas and the axes were present.
      await expect
        .poll(() =>
          chart.evaluate((el) => {
            const canvas = el.querySelector("canvas")!;
            if (!canvas) return 0;
            const ctx = canvas.getContext("2d")!;
            const pixels = ctx.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            let colored = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              const channels = [pixels[i], pixels[i + 1], pixels[i + 2]];
              if (
                pixels[i + 3] > 100 &&
                Math.max(...channels) - Math.min(...channels) > 40
              )
                colored++;
            }
            return colored;
          }),
        )
        .toBeGreaterThan(100);
      const colors = await chart.evaluate((el) => {
        const styles = getComputedStyle(el);
        const probe = document.createElement("span");
        el.appendChild(probe);
        const result: Record<string, string> = {};
        for (const [key, cls] of Object.entries({
          foreground: "text-foreground",
          background: "text-background",
          muted: "text-muted-foreground",
          border: "text-border",
        })) {
          probe.className = cls;
          result[key] = getComputedStyle(probe).color;
        }
        probe.remove();
        return {
          ...result,
          series: styles.getPropertyValue("--color-series0-0").trim(),
        };
      });
      expect(colors.series).not.toBe("");
      expect(colors.foreground).not.toBe(colors.background);
      expect(colors.muted).not.toBe(colors.foreground);
      expect(colors.border).not.toBe(colors.foreground);
      if (kind === "line") {
        const box = await chart.boundingBox();
        await page.mouse.move(
          box!.x + box!.width / 2,
          box!.y + box!.height / 2,
        );
        await expect(chart.getByText("1,050", { exact: true })).toBeVisible();
      }
      await chart.screenshot({
        path: test.info().outputPath(`${kind}-${theme}.png`),
      });
    });
  }
}
