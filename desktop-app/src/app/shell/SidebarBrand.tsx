import type { ReactNode } from "react";
/** Left-aligned wordmark with the sidebar controls grouped on its right. */
export function SidebarBrand({
  controls,
  titleBar = false,
  trafficLights = false,
}: {
  controls?: ReactNode;
  titleBar?: boolean;
  trafficLights?: boolean;
}) {
  return (
    <div
      data-sidebar-header
      className={`flex h-10 min-w-0 w-full items-center justify-between gap-1 ${
        titleBar ? (trafficLights ? "pl-[78px] pr-1.5" : "pl-3 pr-1.5") : "px-3"
      }`}
      data-tauri-drag-region="deep"
    >
      <h1
        data-slot="handwork-brand"
        className="m-0 min-w-0 truncate text-[14px] font-semibold leading-5 tracking-[-0.02em] text-content"
      >
        Handwork
      </h1>
      {controls ? (
        <div className="flex shrink-0 items-center gap-1">{controls}</div>
      ) : null}
    </div>
  );
}
