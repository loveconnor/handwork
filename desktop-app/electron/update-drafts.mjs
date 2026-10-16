import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { validUpdateDrafts } from './ipc.mjs';

export class UpdateDraftStore {
  constructor(file) { this.file = file; }
  save(drafts) {
    if (!validUpdateDrafts(drafts)) throw new Error('Save large drafts before restarting to update.');
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(drafts), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  take() {
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid saved update drafts');
      const drafts = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!validUpdateDrafts(drafts)) throw new Error('Invalid saved update drafts');
      unlinkSync(this.file);
      return drafts;
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
}
