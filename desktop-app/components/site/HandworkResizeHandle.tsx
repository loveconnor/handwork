"use client";

import { HoverTooltip } from "@/components/ui/tooltip";
import { useCallback, useState, type KeyboardEvent, type PointerEvent } from 'react';

function readSize(key: string) {
  try { const value = Number(localStorage.getItem(key)); return Number.isFinite(value) && value > 0 ? value : undefined; } catch { return undefined; }
}

/** A size the user can drag, remembered between launches. `undefined` means the CSS default. */
export function useStoredSize(key: string) {
  const [size, setSize] = useState(() => readSize(key));
  const update = useCallback((value: number | undefined) => {
    setSize(value);
    try { if (value === undefined) localStorage.removeItem(key); else localStorage.setItem(key, String(Math.round(value))); } catch { /* storage is optional */ }
  }, [key]);
  return [size, update] as const;
}

/**
 * A drag handle that resizes a neighbouring element. `measure` returns the element's current size,
 * and `direction` is +1 when dragging right/down grows it and −1 when it shrinks it.
 */
export function ResizeHandle({ orientation, direction, label, min, max, measure, onResize, className }: {
  orientation: 'vertical' | 'horizontal'; direction: 1 | -1; label: string; min: number; max: () => number;
  measure: () => number | undefined; onResize: (size: number | undefined) => void; className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number) => Math.round(Math.min(Math.max(min, max()), Math.max(min, value)));
  const coordinate = (event: { clientX: number; clientY: number }) => orientation === 'vertical' ? event.clientX : event.clientY;

  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const initial = measure();
    if (initial === undefined) return;
    event.preventDefault();
    const handle = event.currentTarget, origin = coordinate(event);
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    document.documentElement.dataset.resizing = orientation;
    const move = (next: globalThis.PointerEvent) => onResize(clamp(initial + direction * (coordinate(next) - origin)));
    const end = () => {
      setDragging(false);
      delete document.documentElement.dataset.resizing;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const grow = orientation === 'vertical' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
    const step = grow[event.key as keyof typeof grow];
    if (event.key === 'Home' || event.key === 'Enter') { event.preventDefault(); onResize(undefined); return; }
    if (!step) return;
    const current = measure();
    if (current === undefined) return;
    event.preventDefault();
    onResize(clamp(current + direction * step * (event.shiftKey ? 64 : 16)));
  };

  const current = measure();
  return <HoverTooltip content={`${label} (double-click to reset)`}><div role="separator" tabIndex={0} aria-orientation={orientation} aria-label={label}
    aria-valuemin={min} aria-valuemax={Math.round(max())} aria-valuenow={current === undefined ? undefined : Math.round(current)}
    className={`handwork-resize-handle${className ? ` ${className}` : ''}`} data-orientation={orientation} data-dragging={dragging ? '' : undefined}
    onPointerDown={start} onDoubleClick={() => onResize(undefined)} onKeyDown={key} /></HoverTooltip>;
}
