import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const MAX_PROMPTS = 500;
const line = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);

/** A prompt the renderer may save: a short title, optional folder, and body text. */
export function validPromptInput(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => ['id', 'title', 'folder', 'text'].includes(key)) &&
    (value.id === undefined || (typeof value.id === 'string' && /^[a-f0-9-]{36}$/.test(value.id))) &&
    line(value.title, 120) && (value.folder === undefined || value.folder === '' || line(value.folder, 60)) &&
    typeof value.text === 'string' && value.text.trim().length > 0 && Buffer.byteLength(value.text) <= 64 * 1024 && !value.text.includes('\0');
}

/** Reusable prompts, stored next to the desktop settings. */
export class SavedPrompts {
  constructor(file) { this.file = file; this.memory = []; }
  list() {
    if (!this.file) return structuredClone(this.memory);
    let data;
    try { data = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Saved prompts could not be read. Keep the file for recovery.'); }
    if (data?.version !== 1 || !Array.isArray(data.prompts)) throw new Error('Saved prompts could not be read. Keep the file for recovery.');
    return data.prompts.filter(prompt => validPromptInput({ id: prompt.id, title: prompt.title, folder: prompt.folder, text: prompt.text }));
  }
  write(prompts) {
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.tmp';
      writeFileSync(temporary, JSON.stringify({ version: 1, prompts }, null, 2), { mode: 0o600 });
      renameSync(temporary, this.file);
    }
    this.memory = prompts;
    return prompts;
  }
  save(input) {
    const prompts = this.list();
    const now = Date.now();
    const existing = input.id ? prompts.find(prompt => prompt.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('This prompt was deleted. Save it as a new prompt.');
    if (!existing && prompts.length >= MAX_PROMPTS) throw new Error(`You can save up to ${MAX_PROMPTS} prompts. Delete one to add another.`);
    const prompt = { id: existing?.id ?? randomUUID(), title: input.title.trim(), folder: input.folder?.trim() ?? '', text: input.text, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.write(existing ? prompts.map(item => item.id === prompt.id ? prompt : item) : [...prompts, prompt]);
    return prompt;
  }
  /** Adds prompts from a backup that are not saved here yet. Returns how many were added. */
  merge(incoming) {
    const prompts = this.list();
    const known = new Set(prompts.map(prompt => prompt.id));
    const now = Date.now();
    const added = incoming.filter(prompt => prompt && validPromptInput({ id: prompt.id, title: prompt.title, folder: prompt.folder || undefined, text: prompt.text }) && !known.has(prompt.id) && known.add(prompt.id))
      .slice(0, Math.max(0, MAX_PROMPTS - prompts.length))
      .map(prompt => ({ id: prompt.id, title: prompt.title.trim(), folder: prompt.folder?.trim() ?? '', text: prompt.text, createdAt: Number(prompt.createdAt) || now, updatedAt: Number(prompt.updatedAt) || now }));
    if (added.length) this.write([...prompts, ...added]);
    return added.length;
  }
  remove(id) {
    const prompts = this.list();
    if (!prompts.some(prompt => prompt.id === id)) throw new Error('This prompt was already deleted.');
    this.write(prompts.filter(prompt => prompt.id !== id));
    return { removed: true };
  }
}
