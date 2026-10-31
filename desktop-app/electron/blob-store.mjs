import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const BLOB = /^[a-f0-9]{64}$/;

/**
 * Attachment bytes stored once by content hash, for stores that keep unsent work
 * (drafts, queued messages). Without a directory the blobs stay in memory.
 */
export class BlobStore {
  constructor(directory, limit) {
    this.directory = directory;
    this.limit = limit;
    this.memory = new Map();
  }

  bytes() {
    if (!this.directory) return [...this.memory.values()].reduce((total, bytes) => total + bytes.length, 0);
    if (!existsSync(this.directory)) return 0;
    return readdirSync(this.directory).filter(name => BLOB.test(name)).reduce((total, name) => total + statSync(path.join(this.directory, name)).size, 0);
  }

  /** Returns the blob name, or null when storing it would pass the size limit. */
  put(content, used) {
    const bytes = Buffer.from(content);
    const name = createHash('sha256').update(bytes).digest('hex');
    if (!this.directory) {
      if (this.memory.has(name)) return name;
      if (used + bytes.length > this.limit) return null;
      this.memory.set(name, bytes); return name;
    }
    const file = path.join(this.directory, name);
    if (existsSync(file)) return name;
    if (used + bytes.length > this.limit) return null;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    writeFileSync(file + '.tmp', bytes, { mode: 0o600 });
    renameSync(file + '.tmp', file);
    return name;
  }

  get(name) {
    if (typeof name !== 'string' || !BLOB.test(name)) return undefined;
    try { return this.directory ? readFileSync(path.join(this.directory, name)) : this.memory.get(name); } catch { return undefined; }
  }

  /** Deletes blobs that nothing refers to any more. */
  keep(used) {
    if (!this.directory) { for (const name of this.memory.keys()) if (!used.has(name)) this.memory.delete(name); return; }
    if (!existsSync(this.directory)) return;
    for (const name of readdirSync(this.directory)) if (BLOB.test(name) && !used.has(name)) { try { unlinkSync(path.join(this.directory, name)); } catch { /* Retried on the next save. */ } }
  }

  /** Checks a whole save before writing any blobs, counting each new hash once. */
  canFit(files) {
    let used = this.bytes();
    const seen = new Set();
    for (const file of files) {
      const content = file.data !== undefined ? Buffer.from(file.data, 'base64') : Buffer.from(file.text ?? '', 'utf8');
      const name = createHash('sha256').update(content).digest('hex');
      if (seen.has(name)) continue;
      seen.add(name);
      if (this.directory ? existsSync(path.join(this.directory, name)) : this.memory.has(name)) continue;
      used += content.length;
    }
    return used <= this.limit;
  }

  /** Stores attachments as blob references. Files that do not fit are counted as skipped. */
  encode(files) {
    let used = this.bytes();
    let skipped = 0;
    const saved = files.map(file => {
      const content = file.data !== undefined ? Buffer.from(file.data, 'base64') : Buffer.from(file.text ?? '', 'utf8');
      const name = createHash('sha256').update(content).digest('hex');
      const existing = this.directory ? existsSync(path.join(this.directory, name)) : this.memory.has(name);
      const blob = this.put(content, used);
      if (!blob) { skipped++; return null; }
      if (!existing) used += content.length;
      return { name: file.name, mimeType: file.mimeType, size: file.size, ...(file.uri ? { uri: file.uri } : {}), encoding: file.data !== undefined ? 'base64' : 'text', blob };
    }).filter(Boolean);
    return { saved, skipped };
  }

  /** Attachments restored from blob references; unreadable ones are dropped. */
  decode(files) {
    return (Array.isArray(files) ? files : []).flatMap(file => {
      const bytes = this.get(file?.blob);
      if (!bytes) return [];
      const base = { name: String(file.name), mimeType: String(file.mimeType), size: Number(file.size) || bytes.length, ...(typeof file.uri === 'string' ? { uri: file.uri } : {}) };
      return [file.encoding === 'text' ? { ...base, text: bytes.toString('utf8') } : { ...base, data: bytes.toString('base64') }];
    });
  }
}

/** Writes JSON atomically with owner-only permissions. */
export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(file + '.tmp', file);
}
