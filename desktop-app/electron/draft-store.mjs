import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const MAX_DRAFTS = 200;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const BLOB = /^[a-f0-9]{64}$/;

/**
 * Unsent composer text and attachments, saved as the person types so a quit or
 * crash does not lose them. Attachment bytes are stored once by content hash.
 */
export class DraftStore {
  constructor(directory) {
    this.directory = directory;
    this.index = directory ? path.join(directory, 'drafts.json') : null;
    this.blobs = directory ? path.join(directory, 'blobs') : null;
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
    if (!this.index) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(this.index + '.tmp', JSON.stringify({ version: 1, drafts }), { mode: 0o600 });
    renameSync(this.index + '.tmp', this.index);
    // Attachments no draft refers to any more are removed.
    const used = new Set(Object.values(drafts).flatMap(draft => draft.files.map(file => file.blob)).filter(Boolean));
    if (!existsSync(this.blobs)) return;
    for (const name of readdirSync(this.blobs)) if (BLOB.test(name) && !used.has(name)) { try { unlinkSync(path.join(this.blobs, name)); } catch { /* Retried on the next save. */ } }
  }

  storeBlob(content, used) {
    const bytes = Buffer.from(content);
    const name = createHash('sha256').update(bytes).digest('hex');
    if (!this.blobs) { this.memoryBlobs ??= new Map(); this.memoryBlobs.set(name, bytes); return name; }
    const file = path.join(this.blobs, name);
    if (existsSync(file)) return name;
    if (used + bytes.length > MAX_BLOB_BYTES) return null;
    mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
    writeFileSync(file + '.tmp', bytes, { mode: 0o600 });
    renameSync(file + '.tmp', file);
    return name;
  }

  blobBytes() {
    if (!this.blobs || !existsSync(this.blobs)) return 0;
    return readdirSync(this.blobs).filter(name => BLOB.test(name)).reduce((total, name) => total + statSync(path.join(this.blobs, name)).size, 0);
  }

  /** `files` of null keeps the attachments already saved for this chat. */
  save(key, text, files) {
    const drafts = this.read();
    const previous = Object.hasOwn(drafts, key) ? drafts[key] : undefined;
    let saved = previous?.files ?? [];
    let skipped = 0;
    if (files) {
      let used = this.blobBytes();
      saved = files.map(file => {
        const content = file.data !== undefined ? Buffer.from(file.data, 'base64') : Buffer.from(file.text ?? '', 'utf8');
        const blob = this.storeBlob(content, used);
        if (!blob) { skipped++; return null; }
        used += content.length;
        return { name: file.name, mimeType: file.mimeType, size: file.size, ...(file.uri ? { uri: file.uri } : {}), encoding: file.data !== undefined ? 'base64' : 'text', blob };
      }).filter(Boolean);
    }
    if (!text.trim() && !saved.length) delete drafts[key];
    else drafts[key] = { text, files: saved, updatedAt: Date.now() };
    const keys = Object.keys(drafts).sort((a, b) => drafts[b].updatedAt - drafts[a].updatedAt);
    for (const old of keys.slice(MAX_DRAFTS)) delete drafts[old];
    this.write(drafts);
    return { saved: true, skipped };
  }

  /** Every saved draft with its attachments restored; unreadable attachments are dropped. */
  list() {
    return Object.entries(this.read()).map(([id, draft]) => {
      const files = (Array.isArray(draft.files) ? draft.files : []).flatMap(file => {
        if (!file || typeof file.blob !== 'string' || !BLOB.test(file.blob)) return [];
        let bytes;
        try { bytes = this.blobs ? readFileSync(path.join(this.blobs, file.blob)) : this.memoryBlobs?.get(file.blob); } catch { return []; }
        if (!bytes) return [];
        const base = { name: String(file.name), mimeType: String(file.mimeType), size: Number(file.size) || bytes.length, ...(typeof file.uri === 'string' ? { uri: file.uri } : {}) };
        return [file.encoding === 'text' ? { ...base, text: bytes.toString('utf8') } : { ...base, data: bytes.toString('base64') }];
      });
      return { id, text: typeof draft.text === 'string' ? draft.text : '', files, updatedAt: Number(draft.updatedAt) || 0 };
    }).filter(draft => draft.text.trim() || draft.files.length).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  remove(keys) {
    const drafts = this.read();
    for (const key of keys) delete drafts[key];
    this.write(drafts);
  }
}
