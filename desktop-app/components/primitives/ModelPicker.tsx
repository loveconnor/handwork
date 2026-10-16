"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import GlideMenu from "@/components/primitives/GlideMenu";
import { ProviderLogo } from "@/components/atoms/ProviderLogo";
import { IconCheck, IconPlus, IconSearch, IconUndo, IconZap } from "@/components/atoms/Icons";
import { InlineSlider } from "@/components/motion/InlineSlider";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────
 * MODEL PICKER
 * A provider rail, a searchable model list with ⌘-number
 * shortcuts, and a reasoning-effort slider for the chosen
 * model. Every value comes from the engine's config options.
 * ───────────────────────────────────────────────────────── */

export type PickerChoice = { value: string; name: string; description?: string };

export type ModelPickerProps = {
  models: PickerChoice[];
  modelValue?: string;
  onSelectModel: (value: string) => void;
  providers?: PickerChoice[];
  providerValue?: string;
  onSelectProvider?: (value: string) => void;
  efforts?: PickerChoice[];
  effortValue?: string;
  onSelectEffort?: (value: string) => void;
  fastMode?: boolean;
  onToggleFastMode?: () => void;
  disabled?: boolean;
  /** Opens provider management; the rail only lists connected providers. */
  onManageProviders?: () => void;
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
};

const label = (choice?: PickerChoice) => choice ? choice.name.charAt(0).toUpperCase() + choice.name.slice(1) : "";

export default function ModelPicker({ models, modelValue, onSelectModel, providers = [], providerValue, onSelectProvider, efforts = [], effortValue, onSelectEffort, fastMode = false, onToggleFastMode, disabled = false, onManageProviders, onClose, className = "", style }: ModelPickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(() => Math.max(0, models.findIndex((m) => m.value === modelValue)));
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const provider = providers.find((p) => p.value === providerValue);
  const current = models.find((m) => m.value === modelValue);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? models.filter((m) => m.name.toLowerCase().includes(needle) || m.value.toLowerCase().includes(needle)) : models;
  }, [models, query]);
  const effortIndex = Math.max(0, efforts.findIndex((e) => e.value === effortValue));

  useEffect(() => { searchRef.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { rowRefs.current[active]?.scrollIntoView({ block: "nearest" }); }, [active]);

  const choose = (choice?: PickerChoice) => {
    if (!choice) return;
    if (choice.value !== modelValue) onSelectModel(choice.value);
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      choose(visible[Number(event.key) - 1]);
      return;
    }
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!visible.length) return;
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : visible.length - 1)) % visible.length);
      return;
    }
    if (event.key === "Enter" && event.target === searchRef.current) { event.preventDefault(); choose(visible[active]); }
  };

  return (
    <div role="dialog" aria-label="Model picker" onKeyDown={onKeyDown} className={cn("relative flex overflow-hidden rounded-[14px] bg-surface text-ink shadow-raised", className)} style={style}>
      {/* The rail is absolutely positioned so the main column decides the height; long provider lists scroll inside it. */}
      {(providers.length > 0 || onManageProviders) && (
        <div className="absolute inset-y-0 left-0 flex w-12 flex-col items-center gap-1 overflow-y-auto border-r border-line py-2 [scrollbar-width:none]" role="tablist" aria-label="Providers">
          {providers.map((item) => {
            const selected = item.value === providerValue;
            return (
              <button key={item.value} type="button" role="tab" aria-selected={selected} aria-label={item.name} title={item.name}
                onClick={() => { if (!selected) onSelectProvider?.(item.value); setQuery(""); searchRef.current?.focus(); }}
                className={`relative flex size-9 items-center justify-center rounded-[9px] transition-colors duration-150 ${selected ? "bg-hover-2 text-ink" : "text-ink-3 hover:bg-hover hover:text-ink-2"}`}>
                {selected && <span aria-hidden className="absolute -left-1.5 top-2 h-5 w-0.5 rounded-full bg-accent" />}
                <ProviderLogo provider={item.value} name={item.name} size={16} />
              </button>
            );
          })}
          {onManageProviders && (
            <button type="button" aria-label="Manage providers" title="Connect providers" onClick={() => { onClose(); onManageProviders(); }}
              className="mt-auto flex size-9 shrink-0 items-center justify-center rounded-[9px] text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink">
              <IconPlus size={15} strokeWidth={2} />
            </button>
          )}
        </div>
      )}
      <div className={`flex min-w-0 flex-1 flex-col ${providers.length > 0 || onManageProviders ? "pl-12" : ""}`}>
        <label className="flex h-11 items-center gap-2 border-b border-line px-3 text-ink-3 focus-within:text-ink-2">
          <IconSearch size={15} strokeWidth={2} />
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models…" aria-label="Search models"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3" />
          {provider && <span className="shrink-0 text-[11px] text-ink-3">{provider.name}</span>}
        </label>
        <GlideMenu className="max-h-60 overflow-y-auto p-1" highlightClassName="inset-x-1 rounded-[8px] bg-hover">
          <div role="listbox" aria-label="Models">
            {visible.map((item, index) => {
              const selected = item.value === modelValue;
              return (
                <button key={item.value} type="button" role="option" aria-selected={selected} data-menu-row
                  ref={(el) => { rowRefs.current[index] = el; }}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(item)}
                  className={`relative z-10 flex h-11 w-full items-center gap-3 rounded-[8px] px-2.5 text-left ${index === active ? "text-ink" : "text-ink"}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{item.name}</span>
                    {provider && <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-3"><ProviderLogo provider={provider.value} name={provider.name} size={11} />{provider.name}</span>}
                  </span>
                  {index < 9 && <kbd className="shrink-0 rounded-[6px] bg-field px-1.5 py-0.5 font-mono text-[10.5px] text-ink-3 shadow-hairline">⌘{index + 1}</kbd>}
                  <span className={`shrink-0 text-ink ${selected ? "" : "invisible"}`}><IconCheck size={14} strokeWidth={2.5} /></span>
                </button>
              );
            })}
            {visible.length === 0 && <div className="flex h-11 items-center px-2.5 text-[12.5px] text-ink-3">No models match “{query}”</div>}
          </div>
        </GlideMenu>
        {(efforts.length > 0 || onToggleFastMode) && (
          <div className="border-t border-line px-3 pb-3 pt-2.5">
            <div className="flex items-center gap-2">
              <button type="button" aria-label="Fast mode" aria-pressed={fastMode} disabled={disabled || !onToggleFastMode}
                title={onToggleFastMode ? `Fast mode ${fastMode ? "on" : "off"} · Additional usage costs may apply` : "Fast mode unavailable for this model"}
                onClick={onToggleFastMode}
                className={`flex size-7 items-center justify-center rounded-[7px] transition-colors duration-150 disabled:opacity-40 ${fastMode ? "bg-accent/15 text-accent" : "text-ink-3 hover:bg-hover hover:text-ink"}`}>
                <IconZap size={15} />
              </button>
              <div className="min-w-0 flex-1 text-center">
                <p className="truncate text-[13px] font-medium text-ink">{current?.name ?? "Reasoning effort"}</p>
                <p className="text-[11.5px] text-ink-3">{efforts.length > 0 ? "How much the model thinks before answering" : "Use faster service for this model"}</p>
              </div>
              {efforts.length > 0 && <button type="button" aria-label="Reset reasoning effort" disabled={effortIndex === 0} onClick={() => efforts[0] && onSelectEffort?.(efforts[0].value)}
                className="flex size-7 items-center justify-center rounded-[7px] text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-40">
                <IconUndo size={14} />
              </button>}
            </div>
            {efforts.length > 0 && <InlineSlider
              label="Reasoning"
              aria-label="Reasoning effort"
              min={0}
              max={Math.max(0, efforts.length - 1)}
              step={1}
              value={effortIndex}
              onValueChange={(index) => { const next = efforts[Math.round(index)]; if (next && next.value !== effortValue) onSelectEffort?.(next.value); }}
              format={(index) => label(efforts[Math.round(index)])}
              className="mt-2.5 bg-field"
            />}
          </div>
        )}
      </div>
    </div>
  );
}
