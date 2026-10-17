import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BlobStore, writeJson } from './blob-store.mjs';

export const MAX_QUEUED = 50;
const MAX_QUEUES = 200;
const MAX_BLOB_BYTES = 128 * 1024 * 1024;

/**
 * Follow-ups waiting to send, per chat, in order, with their attachments and
 * whether the person paused them. Saved on every change so a quit keeps them.
 */
export class QueueStore {
  constructor(directory) {
    this.directory = directory;
    this.index = directory ? path.join(directory, 'queues.json') : null;
    this.blobs = new BlobStore(directory ? path.join(directory, 'blobs') : null, MAX_BLOB_BYTES);
    this.memory = {};
  }

  read() {
    if (!this.index) return structuredClone(this.memory);
    try {
      const data = JSON.parse(readFileSync(this.index, 'utf8'));
      return data?.version === 1 && data.queues && typeof data.queues === 'object' && !Array.isArray(data.queues) ? data.queues : {};
    } catch { return {}; }
  }

  write(queues) {
    this.memory = queues;
    if (this.index) writeJson(this.index, { version: 1, queues });
    this.blobs.keep(new Set(Object.values(queues).flatMap(queue => queue.items.flatMap(item => item.files.map(file => file.blob)))));
  }

  /** Replaces one chat's queue. An empty queue is removed. */
  save(sessionId, { paused, items }) {
    const queues = this.read();
    // Attachments already stored for an unchanged message are reused, not re-encoded.
    const previous = new Map((queues[sessionId]?.items ?? []).map(item => [item.id, item]));
    let skipped = 0;
    const saved = items.map(item => {
      const known = previous.get(item.id);
      if (known && known.text === item.text && known.files.length === item.files.length) return known;
      const encoded = this.blobs.encode(item.files);
      skipped += encoded.skipped;
      return { id: item.id, text: item.text, files: encoded.saved, queuedAt: Number(item.queuedAt) || Date.now() };
    });
    if (!saved.length) delete queues[sessionId];
    else queues[sessionId] = { paused: paused === true, items: saved, updatedAt: Date.now() };
    const keys = Object.keys(queues).sort((a, b) => queues[b].updatedAt - queues[a].updatedAt);
    for (const old of keys.slice(MAX_QUEUES)) delete queues[old];
    this.write(queues);
    return { saved: true, skipped };
  }

  /** Every saved queue with its attachments restored. */
  list() {
    return Object.entries(this.read()).map(([sessionId, queue]) => ({
      sessionId, paused: queue?.paused === true, updatedAt: Number(queue?.updatedAt) || 0,
      items: (Array.isArray(queue?.items) ? queue.items : []).filter(item => item && typeof item.id === 'string' && typeof item.text === 'string')
        .map(item => ({ id: item.id, text: item.text, files: this.blobs.decode(item.files), queuedAt: Number(item.queuedAt) || 0 }))
        .filter(item => item.text.trim() || item.files.length),
    })).filter(queue => queue.items.length).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  remove(sessionIds) {
    const queues = this.read();
    let removed = 0;
    for (const id of sessionIds) if (Object.hasOwn(queues, id)) { delete queues[id]; removed++; }
    if (removed) this.write(queues);
    return removed;
  }
}
