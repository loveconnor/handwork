// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MonoIntroCard } from "./MonoIntro";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const look = { mascot: "cat", color: "hsl(142 55% 50%)" };

function button(label: string) {
  return [...document.body.querySelectorAll("button")].find(
    (entry) => entry.textContent === label,
  )!;
}

it("creates the first mono or hides monos", () => {
  const onCreate = vi.fn();
  const onHide = vi.fn();
  act(() =>
    root.render(
      createElement(MonoIntroCard, {
        look,
        onCreate,
        onHide,
      }),
    ),
  );

  expect(document.body.textContent).toContain("Create a Hand");
  expect(
    document.body.querySelectorAll("[data-mono-intro-stage] svg"),
  ).toHaveLength(0);

  act(() => button("Create a Hand").click());
  expect(onCreate).toHaveBeenCalledOnce();
  act(() =>
    document.body.querySelector<HTMLElement>('[role="switch"]')!.click(),
  );
  expect(onHide).toHaveBeenCalledOnce();
});
