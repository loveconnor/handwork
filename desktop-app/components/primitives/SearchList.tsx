"use client";

import { useState } from "react";
import GlideMenu from "@/components/primitives/GlideMenu";
import { IconClose, IconSearch } from "@/components/atoms/Icons";

/* ─────────────────────────────────────────────────────────
 * SEARCH — command search with live filtering.
 * The field, clear action, and results are directly usable.
 * ───────────────────────────────────────────────────────── */

export type SearchItem = string;

export type SearchListLabels = {
  placeholder: string;
  ariaLabel: string;
  emptyTitle: string;
  emptyHint: string;
};

const ITEMS: SearchItem[] = [
  "Forecast summer demand",
  "Find waffle cone suppliers",
  "Compare seasonal flavors",
  "Draft flavor launch plan",
  "Check cold-chain status",
  "Audit sugar costs",
  "Retire low sellers",
];

const LABELS: SearchListLabels = {
  placeholder: "Search flavors…",
  ariaLabel: "Search flavors",
  emptyTitle: "No results found",
  emptyHint: "Adjust your search to try again",
};

export default function SearchList({
  items = ITEMS,
  labels = LABELS,
}: {
  items?: SearchItem[];
  labels?: SearchListLabels;
  variant?: string;
} = {}) {
  const [query, setQuery] = useState("");
  const results = query
    ? items.filter((i) => i.toLowerCase().includes(query.toLowerCase()))
    : items.slice(0, 5);
  const empty = query.length > 2 && results.length === 0;

  return (
    <div className="flex min-h-[248px] w-full max-w-72 flex-col items-stretch">
      <div className="w-full self-start overflow-hidden rounded-card bg-surface shadow-raised">
        {/* input row */}
        <div className="flex h-10 items-center gap-2 border-b border-line px-3 transition-colors duration-100 hover:bg-hover">
          <IconSearch size={14} strokeWidth={2} stroke="var(--ink-3)" className="shrink-0" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.placeholder}
            aria-label={labels.ariaLabel}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
          {query && (
            <button
              aria-label="Clear search"
              type="button"
              onClick={() => setQuery("")}
              className="flex size-6 items-center justify-center rounded-full text-ink-3
                transition-colors duration-100 hover:bg-line/70 hover:text-ink"
              style={{ animation: "fade-in 150ms ease-out both" }}
            >
              <IconClose size={11} strokeWidth={2.2} />
            </button>
          )}
        </div>

        {/* results / empty state */}
        {empty ? (
          <div className="flex flex-col items-center justify-center gap-1 px-4 py-8" style={{ animation: "fade-in 250ms ease-out both" }}>
            <span className="mb-1.5 flex size-8 items-center justify-center rounded-control bg-inset text-ink-3 shadow-hairline">
              <IconSearch size={15} strokeWidth={1.8} />
            </span>
            <span className="text-[13px] font-medium text-ink">{labels.emptyTitle}</span>
            <span className="text-[12px] text-ink-3">{labels.emptyHint}</span>
          </div>
        ) : (
          <div className="p-1">
            <GlideMenu className="flex flex-col gap-px" highlightClassName="inset-x-0 rounded-[6px] bg-hover">
              {results.map((item) => (
                <button
                  key={item}
                  data-menu-row
                  type="button"
                  onClick={() => setQuery(item)}
                  className="relative z-10 flex h-8 w-full items-center rounded-[6px] px-2 text-left text-[13px] text-ink"
                  style={{ animation: "fade-in 200ms ease-out both" }}
                >
                  {item}
                </button>
              ))}
            </GlideMenu>
          </div>
        )}
      </div>
    </div>
  );
}
