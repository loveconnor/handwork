import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 5000;
// Never listed: they are tooling state, not project files.
const HIDDEN = new Set(['.git', '.DS_Store', 'Thumbs.db']);

const inside = (root, target) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const revisionOf = bytes => createHash('sha256').update(bytes).digest('hex');

/** A project-relative path as the renderer sends it: forward slashes, no escapes. */
export function validProjectPath(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096 || value.includes('\0') || value.includes('\\')) return false;
  if (value === '') return allowRoot;
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) return false;
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/**
 * Browse, read and write files inside the open project. Every path is resolved
 * against the project's real location and must stay inside it, through
 * symlinks too. Writes are atomic and carry the revision the editor loaded, so
 * a file changed on disk since it was opened is never silently overwritten.
 */
export class ProjectFiles {
  /** `ignored(root, paths)` names the listed paths the project ignores, such as build output; they are shown dimmed. */
  constructor({ ignored = async () => new Set() } = {}) { this.ignored = ignored; }

  async root(workspace) {
    if (!workspace) throw new Error('Open a project to browse its files.');
    return realpath(workspace);
  }

  /** The real, contained location of a project path; the file itself need not exist yet. */
  async resolve(workspace, relative, { allowRoot = false } = {}) {
    if (!validProjectPath(relative, { allowRoot })) throw new Error('That path is not inside the project.');
    const root = await this.root(workspace);
    const target = path.join(root, ...relative.split('/').filter(Boolean));
    const real = await realpath(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    const checked = real ?? path.join(await realpath(path.dirname(target)), path.basename(target));
    if (!inside(root, checked)) throw new Error('That path is outside the project.');
    return { root, absolute: checked, exists: !!real };
  }

  async list(workspace, relative = '') {
    const { root, absolute } = await this.resolve(workspace, relative, { allowRoot: true });
    const entries = [];
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (HIDDEN.has(entry.name)) continue;
      let kind = entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : null;
      if (entry.isSymbolicLink()) {
        // A link is listed only when it points inside the project.
        const target = await realpath(path.join(absolute, entry.name)).catch(() => null);
        if (!target || !inside(root, target)) continue;
        kind = (await stat(target)).isDirectory() ? 'directory' : 'file';
      }
      if (!kind) continue;
      entries.push({ name: entry.name, path: relative ? `${relative}/${entry.name}` : entry.name, kind });
      if (entries.length >= MAX_ENTRIES) break;
    }
    entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    // Ignored entries are a nicety; a failed lookup leaves the tree undimmed, never broken.
    const ignored = await this.ignored(root, entries.map(entry => entry.path)).catch(() => new Set());
    for (const entry of entries) if (ignored.has(entry.path)) entry.ignored = true;
    return { path: relative, entries, truncated: entries.length >= MAX_ENTRIES };
  }

  async read(workspace, relative) {
    const { absolute } = await this.resolve(workspace, relative);
    const info = await lstat(absolute);
    if (!info.isFile()) throw new Error(`${path.basename(absolute)} is not a file.`);
    if (info.size > MAX_EDIT_BYTES) return { path: relative, size: info.size, tooLarge: true, revision: null, text: null };
    const handle = await open(absolute, 'r');
    try {
      const bytes = await handle.readFile();
      // A NUL byte in the first 8 KB marks a binary file, as git decides.
      const binary = bytes.subarray(0, 8192).includes(0);
      return { path: relative, size: bytes.length, binary, tooLarge: false, revision: revisionOf(bytes), text: binary ? null : bytes.toString('utf8') };
    } finally { await handle.close(); }
  }

  async write(workspace, relative, text, revision) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_EDIT_BYTES) throw new Error('That file is too large to save from Handwork.');
    const { absolute, exists } = await this.resolve(workspace, relative);
    let mode;
    if (exists) {
      const info = await lstat(absolute);
      if (!info.isFile()) throw new Error(`${path.basename(absolute)} is not a file.`);
      mode = info.mode & 0o7777;
    }
    const before = exists ? await this.read(workspace, relative) : null;
    if (before?.tooLarge) throw new Error(`${path.basename(absolute)} is too large to save from Handwork.`);
    if (revision !== (before?.revision ?? null)) throw Object.assign(new Error(`${path.basename(absolute)} changed on disk since you opened it.`), { code: 'CONFLICT' });
    const bytes = Buffer.from(text, 'utf8');
    const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.handwork-tmp`);
    try {
      await writeFile(temporary, bytes, { mode: mode ?? 0o644, flag: 'wx' });
      await rename(temporary, absolute);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return { path: relative, revision: revisionOf(bytes), size: bytes.length };
  }
}
