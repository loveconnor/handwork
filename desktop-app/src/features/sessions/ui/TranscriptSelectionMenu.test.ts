// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranscriptSelectionMenu } from "./TranscriptSelectionMenu";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("offers selected text to chat without a Notes action", async () => {
  const onAddToChat = vi.fn();
  const onDismiss = vi.fn();
  act(() =>
    root.render(
      createElement(TranscriptSelectionMenu, {
        selection: {
          text: "A useful link",
          rect: new DOMRect(10, 20, 100, 20),
        },
        onAddToChat,
        onDismiss,
      }),
    ),
  );
  const toolbar = document.querySelector('[role="toolbar"]')!;
  expect(toolbar.textContent).toContain("Add to chat");
  expect(toolbar.textContent).not.toContain("Add to notes");
  await act(async () =>
    toolbar.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(onAddToChat).toHaveBeenCalledWith("A useful link");
  expect(onDismiss).toHaveBeenCalledOnce();
});
