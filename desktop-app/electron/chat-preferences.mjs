import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/** Desktop titles and pins are independent of the engine's generated titles. */
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
    delete data[id];
    this.write(data);
  }
}
