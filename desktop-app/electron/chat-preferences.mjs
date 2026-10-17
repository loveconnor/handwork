import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Desktop titles, pins, archive state, and version links are independent of the
 * engine's generated titles. `branch` records which chat an edit or retry came from.
 */
export class ChatPreferences {
  constructor(file) { this.file = file; this.memory = {}; }
  list() {
    let data = this.memory;
    if (this.file) {
      try { data = JSON.parse(readFileSync(this.file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; else data = {}; }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid chat preferences');
    return data;
  }
  write(data) {
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.tmp';
      writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
      renameSync(temporary, this.file);
    }
    this.memory = data;
  }
  update(id, changes) {
    const data = this.list();
    const value = { ...(Object.hasOwn(data, id) ? data[id] : {}), ...changes };
    this.write({ ...data, [id]: value });
    return value;
  }
  remove(id) {
    const data = this.list();
    const removed = Object.hasOwn(data, id) ? data[id]?.branch : undefined;
    delete data[id];
    // Versions made from the deleted chat stay linked to the versions they still match.
    const orphans = Object.entries(data).filter(([, value]) => value?.branch?.from === id)
      .sort(([, a], [, b]) => a.branch.at - b.branch.at);
    const roots = new Map();
    for (const [child, value] of orphans) {
      const { branch, ...rest } = value;
      // Turns before the deleted chat's own branch point match its original too.
      if (removed && branch.turn <= removed.turn) data[child] = { ...rest, branch: { ...branch, from: removed.from } };
      // Otherwise the oldest version of that turn becomes the original for the others.
      else if (roots.has(branch.turn)) data[child] = { ...rest, branch: { ...branch, from: roots.get(branch.turn) } };
      else { roots.set(branch.turn, child); data[child] = rest; }
    }
    this.write(data);
  }
}
