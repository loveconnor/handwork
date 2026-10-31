"use client";

import { useCallback, useEffect, useRef } from 'react';
import { LoaderCircle, MessageSquare, Plus, X } from 'honestui/icons';
import { HoverTooltip } from '@/components/ui/tooltip';
import { bindHorizontalWheel } from '@/lib/horizontal-scroll';
import { shortcutLabel } from '@/lib/saved-prompts';
import type { AttentionKind } from '@/lib/attention';
import { AttentionIcon } from './HandworkAttention';

type Tab = { id: string; label: string; workspace?: string };

// The same words the sidebar uses for the same states.
const flagLabel = (kind: AttentionKind) => kind === 'approval' ? 'Needs you: waiting for approval' : kind === 'failed' ? 'Reply failed' : kind === 'queue' ? 'Queue paused' : 'Reply paused';

/**
 * Open chats as tabs in the title row, as the native app had them: equal widths
 * that shrink together, then scroll. Each tab leads with its state (working,
 * waiting, unread) where a quiet chat icon otherwise sits, so labels never shift.
 */
export function HandworkTabs({ tabs, activeId, titleOf, running, unread, attention, selectDisabled, closeDisabled, newDisabled, onSelect, onClose, onNew }: {
  tabs: Tab[];
  activeId: string;
  titleOf: (tab: Tab) => string;
  running: Set<string>;
  unread: Set<string>;
  attention: Map<string, AttentionKind>;
  selectDisabled: boolean;
  closeDisabled: boolean;
  newDisabled: boolean;
  onSelect: (tab: Tab) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  const strip = useRef<HTMLDivElement | null>(null);
  const bind = useCallback((element: HTMLDivElement | null) => {
    strip.current = element;
    if (element) return bindHorizontalWheel(element);
  }, []);

  // Keep the current tab in view, clear of the fade, when it changes or a new
  // one opens past the edge; again once an opening tab has grown to full width.
  const reveal = useCallback(() => {
    const element = strip.current;
    const tab = element?.querySelector<HTMLElement>('[data-tab-active]');
    if (!element || !tab) return;
    const fade = 40;
    const start = tab.offsetLeft - element.offsetLeft;
    const end = start + tab.offsetWidth;
    if (start - fade < element.scrollLeft) element.scrollLeft = Math.max(0, start - fade);
    else if (end + fade > element.scrollLeft + element.clientWidth) element.scrollLeft = end + fade - element.clientWidth;
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(reveal);
    return () => cancelAnimationFrame(frame);
  }, [activeId, tabs.length, reveal]);
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const grown = (event: TransitionEvent) => { if (event.propertyName === 'flex-basis') reveal(); };
    element.addEventListener('transitionend', grown);
    return () => element.removeEventListener('transitionend', grown);
  }, [reveal]);
  // Tabs restored at launch arrive at full width; only tabs opened after them grow in.
  const hasTabs = tabs.length > 0;
  useEffect(() => {
    if (!hasTabs) return;
    const frame = requestAnimationFrame(() => strip.current?.setAttribute('data-ready', ''));
    return () => cancelAnimationFrame(frame);
  }, [hasTabs]);

  // Mark each edge that has tabs past it, so the strip fades out there rather
  // than cutting a title off mid-letter.
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const update = () => {
      const maximum = element.scrollWidth - element.clientWidth;
      element.toggleAttribute('data-fade-start', element.scrollLeft > 1);
      element.toggleAttribute('data-fade-end', element.scrollLeft < maximum - 1);
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(element);
    return () => { element.removeEventListener('scroll', update); resize.disconnect(); };
  }, [tabs.length]);

  return <div ref={bind} className="handwork-tabs" role="tablist" aria-label="Open chats">
    {tabs.map(tab => {
      const title = titleOf(tab);
      const active = tab.id === activeId;
      const needs = attention.get(tab.id);
      const flagged = needs && needs !== 'running' ? needs : undefined;
      const working = running.has(tab.id);
      const fresh = unread.has(tab.id) && !active;
      const state = flagged ? flagLabel(flagged) : working ? 'Working' : fresh ? 'New response' : '';
      const project = tab.workspace?.split(/[\\/]/).filter(Boolean).pop();
      return <div key={tab.id} className="handwork-tab" data-tab-active={active || undefined}
        onAuxClick={event => { if (event.button === 1 && !closeDisabled) { event.preventDefault(); onClose(tab.id); } }}>
        <HoverTooltip content={[title, project, state].filter(Boolean).join(' · ')}>
          <button type="button" role="tab" className="handwork-tab-button" aria-selected={active} aria-label={[title, state].filter(Boolean).join(', ')} disabled={selectDisabled} onClick={() => onSelect(tab)}>
            <span className="handwork-tab-icon" data-kind={flagged || (working ? 'running' : fresh ? 'unread' : undefined)} aria-hidden>
              {flagged ? <AttentionIcon kind={flagged} size={14} /> : working ? <LoaderCircle width={14} height={14} className="motion-safe:animate-spin" /> : fresh ? <span className="handwork-chat-unread" /> : <MessageSquare width={14} height={14} />}
            </span>
            <span className="handwork-tab-label">{title}</span>
          </button>
        </HoverTooltip>
        <button type="button" className="handwork-tab-close" aria-label={`Close ${title}`} title={`Close tab (${shortcutLabel('Mod+W')})`} disabled={closeDisabled} onClick={() => onClose(tab.id)}><X width={12} height={12} aria-hidden /></button>
      </div>;
    })}
    <button type="button" className="handwork-new-tab" aria-label="New chat" title={`New chat (${shortcutLabel('Mod+N')})`} disabled={newDisabled} onClick={onNew}><Plus width={14} height={14} aria-hidden /></button>
  </div>;
}
