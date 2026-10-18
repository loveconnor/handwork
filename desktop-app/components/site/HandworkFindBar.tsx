"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { findTextMatches } from '@/lib/find-text';

const BLOCKS = 'p,li,pre,td,th,h1,h2,h3,h4,h5,h6,blockquote,summary,dt,dd,[data-slot="message-content"]';

type Registry = { set(name: string, value: unknown): void; delete(name: string): void };
const registry = (): Registry | undefined => (globalThis.CSS as unknown as { highlights?: Registry } | undefined)?.highlights;
const HighlightClass = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

/** Finds `query` in rendered text, including matches that cross inline formatting. */
function findRanges(root: Element, query: string): Range[] {
  if (!query) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
      // Collapsed activity and hidden helpers are not visible, so they cannot be shown as matches.
      if (parent.closest('[aria-hidden="true"], .handwork-sr-only, .sr-only, script, style, button, [data-slot="reply-actions"]')) return NodeFilter.FILTER_REJECT;
      const details = parent.closest('details');
      if (details && !details.open && !parent.closest('summary')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: { node: Text; start: number }[] = [];
  let flat = ''; let block: Element | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const owner = node.parentElement!.closest(BLOCKS);
    // A separator keeps words in neighbouring paragraphs from matching as one.
    if (owner !== block && flat) flat += '\n';
    block = owner;
    nodes.push({ node, start: flat.length });
    flat += node.nodeValue!;
  }
  const ranges: Range[] = [];
  const locate = (offset: number) => {
    let low = 0; let high = nodes.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (nodes[mid].start <= offset) low = mid; else high = mid - 1; }
    return { node: nodes[low].node, offset: Math.min(offset - nodes[low].start, nodes[low].node.length) };
  };
  for (const match of findTextMatches(flat, query)) {
    const start = locate(match.start); const end = locate(match.end);
    const range = document.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    ranges.push(range);
  }
  return ranges;
}

function scrollParent(element: Element | null): HTMLElement | null {
  for (let current = element?.parentElement; current; current = current.parentElement) {
    const { overflowY } = getComputedStyle(current);
    if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) return current;
  }
  return null;
}

function reveal(range: Range) {
  const element = range.startContainer.parentElement;
  const scroller = scrollParent(element);
  if (!scroller) { element?.scrollIntoView({ block: 'center' }); return; }
  const rect = range.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  // The composer floats over the bottom of the transcript.
  const covered = parseFloat(getComputedStyle(scroller.closest('.handwork-thread') ?? scroller).getPropertyValue('--handwork-composer-height')) || 0;
  const top = box.top + 80; const bottom = box.bottom - covered - 24;
  if (rect.top >= top && rect.bottom <= bottom) return;
  scroller.scrollBy({ top: rect.top - (top + bottom) / 2, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

/** ⌘F: find text in the open chat. */
export function HandworkFindBar({ open, query, onQueryChange, onClose, sessionKey, focusSignal }: {
  open: boolean; query: string; onQueryChange: (query: string) => void; onClose: () => void; sessionKey: string;
  /** Changes each time ⌘F is pressed, so an open bar takes focus again. */
  focusSignal: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  const [count, setCount] = useState(0);
  const [active, setActive] = useState(0);
  const activeRef = useRef(0);
  // Until this time, each recount jumps to the active match again: a chat that is still
  // opening scrolls itself to the newest message, which would hide the match.
  const revealUntil = useRef(0);
  const supported = !!registry() && !!HighlightClass;

  const paint = useCallback((index: number) => {
    const highlights = registry();
    if (!highlights || !HighlightClass) return;
    const list = ranges.current;
    highlights.set('handwork-find', new HighlightClass(...list.filter((_, position) => position !== index)));
    if (list[index]) highlights.set('handwork-find-active', new HighlightClass(list[index])); else highlights.delete('handwork-find-active');
  }, []);

  const compute = useCallback(() => {
    const root = document.querySelector('.handwork-thread .handwork-transcript');
    const next = open && root && query ? findRanges(root, query) : [];
    ranges.current = next;
    setCount(next.length);
    const index = Math.min(activeRef.current, Math.max(0, next.length - 1));
    activeRef.current = index; setActive(index);
    paint(index);
    if (next[index] && Date.now() < revealUntil.current) reveal(next[index]);
  }, [open, query, paint]);

  // A new query or chat starts again from the first match.
  useLayoutEffect(() => {
    activeRef.current = 0; revealUntil.current = Date.now() + 1500;
    const settle = setTimeout(() => { if (ranges.current[activeRef.current] && Date.now() < revealUntil.current + 100) reveal(ranges.current[activeRef.current]); }, 700);
    return () => clearTimeout(settle);
  }, [query, sessionKey]);
  useLayoutEffect(() => { compute(); }, [compute, sessionKey]);
  useEffect(() => {
    if (!open) return;
    const thread = document.querySelector('.handwork-thread');
    if (!thread) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Streaming replies and lazily opened chats change the transcript after the search runs.
    const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(compute, 140); });
    observer.observe(thread, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['open'] });
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [open, compute, sessionKey]);
  useEffect(() => () => { registry()?.delete('handwork-find'); registry()?.delete('handwork-find-active'); }, []);
  useEffect(() => { if (open) requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); }, [open, focusSignal]);

  const step = (direction: 1 | -1) => {
    const total = ranges.current.length;
    if (!total) return;
    const index = (activeRef.current + direction + total) % total;
    activeRef.current = index; setActive(index); paint(index);
    revealUntil.current = 0;
    reveal(ranges.current[index]);
  };

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!open || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'g') return;
      event.preventDefault(); step(event.shiftKey ? -1 : 1);
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  });

  if (!open) return null;
  return <div className="handwork-find" role="search" aria-label="Find in chat" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <Search aria-hidden width={14} height={14} />
    <input ref={input} type="search" aria-label="Find in chat" placeholder="Find in chat" value={query} spellCheck={false}
      onChange={event => onQueryChange(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }} />
    <span className="handwork-find-count" role="status" aria-live="polite">{!supported ? 'Unavailable' : query ? count ? `${active + 1} of ${count}` : 'No results' : ''}</span>
    <Button variant="ghost" size="icon-sm" aria-label="Previous match" title="Previous match (⇧↵)" disabled={!count} onClick={() => step(-1)}><ChevronUp aria-hidden width={14} height={14} /></Button>
    <Button variant="ghost" size="icon-sm" aria-label="Next match" title="Next match (↵)" disabled={!count} onClick={() => step(1)}><ChevronDown aria-hidden width={14} height={14} /></Button>
    <Button variant="ghost" size="icon-sm" aria-label="Close find" title="Close (Esc)" onClick={onClose}><X aria-hidden width={14} height={14} /></Button>
  </div>;
}
