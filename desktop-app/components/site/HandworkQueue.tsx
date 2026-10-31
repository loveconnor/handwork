"use client";

import { HoverTooltip } from "@/components/ui/tooltip";
import { Pencil, X, CornerDownRight, Paperclip } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import type { QueuedMessage } from '@/lib/desktop-api';

export type { QueuedMessage };

/**
 * Follow-ups typed while Handwork is replying. They send in order when it finishes,
 * keep sending while the person reads another chat, and survive a restart paused.
 */
export function HandworkQueue({ items, paused, restored, busy, onEdit, onRemove, onResume, onSendNow, onClear }: {
  items: QueuedMessage[]; paused: boolean; restored: boolean; busy: boolean;
  onEdit: (item: QueuedMessage) => void; onRemove: (item: QueuedMessage) => void;
  onResume: () => void; onSendNow: (item: QueuedMessage) => void; onClear: () => void;
}) {
  const count = `${items.length} queued`;
  const status = restored && paused ? `Saved before Handwork closed · ${count}` : paused ? `Queue paused · ${count}` : busy ? `Sends after this reply · ${count}` : 'Sending next…';
  return <section className="handwork-queue" aria-label="Queued messages" data-attention="queue">
    <header>
      <span>{status}</span>
      {paused && <span className="handwork-queue-actions">
        <Button variant="ghost" size="xs" title="Remove every queued message" onClick={onClear}>Clear</Button>
        <Button data-primary variant="ghost" size="xs" title={busy ? 'Send these after the current reply' : 'Send these in order now'} onClick={busy ? onResume : () => onSendNow(items[0])}>{busy ? 'Resume' : 'Send next'}</Button>
      </span>}
    </header>
    <ol>
      {items.map((item, index) => <li key={item.id}>
        <CornerDownRight aria-hidden className="handwork-queue-marker" />
        <HoverTooltip content={item.text}><span className="handwork-queue-text" >{item.text || 'Attachments only'}</span></HoverTooltip>
        {item.files.length > 0 && <HoverTooltip content={item.files.map(file => file.name).join(', ')}><span className="handwork-queue-files" ><Paperclip aria-hidden />{item.files.length}</span></HoverTooltip>}
        <Button variant="ghost" size="icon-sm" aria-label={`Edit queued message ${index + 1}`} title="Move back to the composer" onClick={() => onEdit(item)}><Pencil aria-hidden /></Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Remove queued message ${index + 1}`} title="Remove" onClick={() => onRemove(item)}><X aria-hidden /></Button>
      </li>)}
    </ol>
  </section>;
}
