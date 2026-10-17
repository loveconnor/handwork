"use client";
import { HoverTooltip } from "@/components/ui/tooltip";
import { CircleAlert, CirclePause, Hand, ListTodo, LoaderCircle, X } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import type { AttentionItem, AttentionKind } from '@/lib/attention';
import { shortcutLabel } from '@/lib/saved-prompts';

const icons: Record<AttentionKind, typeof Hand> = { approval: Hand, failed: CircleAlert, interrupted: CirclePause, queue: ListTodo, running: LoaderCircle };
const names: Record<AttentionKind, string> = { approval: 'Needs approval', failed: 'Failed', interrupted: 'Paused', queue: 'Queue paused', running: 'Working' };
const projectName = (project?: string) => project?.split('/').filter(Boolean).pop() ?? '';

export function AttentionIcon({ kind, size = 14 }: { kind: AttentionKind; size?: number }) {
  const Icon = icons[kind];
  return <Icon aria-hidden width={size} height={size} className={kind === 'running' ? 'motion-safe:animate-spin' : undefined} />;
}

/**
 * Chats that are waiting for the person, then chats that are working, so work in
 * background chats is as visible as the open one. Choosing a row opens the chat at
 * the control that resolves it.
 */
export function HandworkAttention({ items, activeSession, disabled, onOpen, onDismiss }: {
  items: AttentionItem[]; activeSession: string; disabled: boolean;
  onOpen: (item: AttentionItem) => void; onDismiss: (item: AttentionItem) => void;
}) {
  if (!items.length) return null;
  const waiting = items.filter(item => item.kind !== 'running');
  const working = items.filter(item => item.kind === 'running');
  const row = (item: AttentionItem) => <li key={item.id} className="handwork-attention-item" data-kind={item.kind} data-active={item.id === activeSession || undefined}>
    <Button variant="ghost" size="sm" className="handwork-attention-row" disabled={disabled} onClick={() => onOpen(item)}
      aria-label={`${item.label}: ${item.detail}`} title={item.workspace ? `${item.label} · ${projectName(item.workspace)}` : item.label}>
      <HoverTooltip content={names[item.kind]}><span className="handwork-attention-icon" ><AttentionIcon kind={item.kind} /></span></HoverTooltip>
      <span className="handwork-attention-text"><span>{item.label}</span><span>{item.detail}</span></span>
    </Button>
    {(item.kind === 'failed' || item.kind === 'interrupted') && <Button variant="ghost" size="icon-sm" className="handwork-attention-dismiss" aria-label={`Dismiss for ${item.label}`} title="Dismiss" onClick={() => onDismiss(item)}><X aria-hidden width={12} height={12} /></Button>}
  </li>;
  return <section className="handwork-attention" aria-label="Chats that need attention">
    {waiting.length > 0 && <>
      <div className="handwork-attention-heading"><span>Needs you</span><span className="handwork-archived-count">{waiting.length}</span><HoverTooltip content={`Next chat that needs you (${shortcutLabel('Mod+Shift+A')})`}><kbd >{shortcutLabel('Mod+Shift+A')}</kbd></HoverTooltip></div>
      <ul>{waiting.map(row)}</ul>
    </>}
    {working.length > 0 && <>
      <div className="handwork-attention-heading"><span>Working</span><span className="handwork-archived-count">{working.length}</span></div>
      <ul>{working.map(row)}</ul>
    </>}
  </section>;
}
