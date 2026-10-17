"use client";

import { Pencil, X, CornerDownRight, Paperclip } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import type { Attachment } from '@/lib/desktop-api';

export type QueuedMessage = { id: string; text: string; files: Attachment[] };

/** Follow-ups typed while Handwork is replying. They send in order when it finishes. */
export function HandworkQueue({ items, paused, busy, onEdit, onRemove, onResume, onSendNow }: {
  items: QueuedMessage[]; paused: boolean; busy: boolean;
  onEdit: (item: QueuedMessage) => void; onRemove: (item: QueuedMessage) => void;
  onResume: () => void; onSendNow: (item: QueuedMessage) => void;
}) {
  return <section className="handwork-queue" aria-label="Queued messages">
    <header>
      <span>{paused ? 'Queue paused' : busy ? `Sends after this reply · ${items.length} queued` : 'Sending next…'}</span>
      {paused && <Button variant="ghost" size="xs" onClick={busy ? onResume : () => onSendNow(items[0])}>{busy ? 'Resume' : 'Send next'}</Button>}
    </header>
    <ol>
      {items.map((item, index) => <li key={item.id}>
        <CornerDownRight aria-hidden className="handwork-queue-marker" />
        <span className="handwork-queue-text" title={item.text}>{item.text || 'Attachments only'}</span>
        {item.files.length > 0 && <span className="handwork-queue-files" title={item.files.map(file => file.name).join(', ')}><Paperclip aria-hidden />{item.files.length}</span>}
        <Button variant="ghost" size="icon-sm" aria-label={`Edit queued message ${index + 1}`} title="Move back to the composer" onClick={() => onEdit(item)}><Pencil aria-hidden /></Button>
        <Button variant="ghost" size="icon-sm" aria-label={`Remove queued message ${index + 1}`} title="Remove" onClick={() => onRemove(item)}><X aria-hidden /></Button>
      </li>)}
    </ol>
  </section>;
}
