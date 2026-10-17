import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BlobStore, writeJson } from './blob-store.mjs';

const MAX_DRAFTS = 200;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * Unsent composer text and attachments, saved as the person types so a quit or
 * crash does not lose them. Attachment bytes are stored once by content hash.
 */
export class DraftStore {
  constructor(directory) {
    this.directory = directory;
    this.index = directory ? path.join(directory, 'drafts.json') : null;
    this.blobs = new BlobStore(directory ? path.join(directory, 'blobs') : null, MAX_BLOB_BYTES);
    this.memory = {};
  }

  read() {
    if (!this.index) return structuredClone(this.memory);
    try {
      const data = JSON.parse(readFileSync(this.index, 'utf8'));
      return data?.version === 1 && data.drafts && typeof data.drafts === 'object' && !Array.isArray(data.drafts) ? data.drafts : {};
    } catch { return {}; }
  }

  write(drafts) {
    this.memory = drafts;
    if (this.index) writeJson(this.index, { version: 1, drafts });
    // Attachments no draft refers to any more are removed.
    this.blobs.keep(new Set(Object.values(drafts).flatMap(draft => draft.files.map(file => file.blob)).filter(Boolean)));
  }

  /** `files` of null keeps the attachments already saved for this chat. */
  save(key, text, files) {
    const drafts = this.read();
    const previous = Object.hasOwn(drafts, key) ? drafts[key] : undefined;
    let saved = previous?.files ?? [];
    let skipped = 0;
    if (files) ({ saved, skipped } = this.blobs.encode(files));
    if (!text.trim() && !saved.length) delete drafts[key];
    else drafts[key] = { text, files: saved, updatedAt: Date.now() };
    const keys = Object.keys(drafts).sort((a, b) => drafts[b].updatedAt - drafts[a].updatedAt);
    for (const old of keys.slice(MAX_DRAFTS)) delete drafts[old];
    this.write(drafts);
    return { saved: true, skipped };
  }

  /** Every saved draft with its attachments restored; unreadable attachments are dropped. */
  list() {
    return Object.entries(this.read()).map(([id, draft]) => ({ id, text: typeof draft.text === 'string' ? draft.text : '', files: this.blobs.decode(draft.files), updatedAt: Number(draft.updatedAt) || 0 }))
      .filter(draft => draft.text.trim() || draft.files.length).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  remove(keys) {
    const drafts = this.read();
    for (const key of keys) delete drafts[key];
    this.write(drafts);
  }
}
