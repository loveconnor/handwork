// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RailAction } from "./RailAction";
import { Search } from "../../shared/ui/icons";

it("opens Search context actions from the keyboard without navigating", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onClick = vi.fn();
  const onOpenContextMenu = vi.fn();
  try {
    act(() =>
      root.render(
        createElement(RailAction, {
          label: "Search",
          icon: Search,
          onClick,
          onOpenContextMenu,
        }),
      ),
    );
    const button = container.querySelector("button")!;
    act(() =>
      button.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "F10",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(onOpenContextMenu).toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
