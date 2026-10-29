import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 5000;
// Never listed: they are tooling state, not project files.
const HIDDEN = new Set(['.git', '.DS_Store', 'Thumbs.db']);
/** Quick open lists every file; past this the rest of a huge tree is left out. */
export const MAX_INDEX_FILES = 50000;
export const MAX_SEARCH_MATCHES = 2000;
const MAX_SEARCH_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_CHARS = 240;
// Walked only when the project is not a git repository, which already ignores these.
const SKIPPED_DIRECTORIES = new Set([...HIDDEN, 'node_modules', '.next', 'dist', 'build', 'target', '.venv', '__pycache__']);
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Run git in the project and collect its output, up to `limit` bytes. Resolves
 * null when git is missing or the folder is not a repository, so callers can
 * walk the files themselves.
 */
function git(root, args, { limit = MAX_SEARCH_BYTES, okCodes = [0] } = {}) {
  return new Promise(resolve => {
    const child = spawn('git', ['-C', root, '-c', 'core.quotepath=off', ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    let size = 0, truncated = false;
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', chunk => {
      if (truncated) return;
      chunks.push(chunk); size += chunk.length;
      if (size >= limit) { truncated = true; child.kill(); }
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', code => {
      clearTimeout(timer);
      if (!truncated && !okCodes.includes(code)) return resolve(null);
      resolve({ output: Buffer.concat(chunks), truncated });
    });
  });
}

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
  /** `trash(absolute)` moves a deleted path to the system trash, so a delete can be undone outside Handwork. */
  constructor({ ignored = async () => new Set(), trash = null } = {}) { this.ignored = ignored; this.trash = trash; }

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

  /**
   * Where a project path lives without following its last part: the folder
   * it sits in must be real and inside the project; the path itself may be a
   * link, or not exist yet.
   */
  async locate(workspace, relative) {
    if (!validProjectPath(relative)) throw new Error('That path is not inside the project.');
    const root = await this.root(workspace);
    const parent = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '';
    const folder = await this.resolve(workspace, parent, { allowRoot: true });
    if (!folder.exists) throw new Error(`The folder ${parent} does not exist.`);
    const absolute = path.join(folder.absolute, path.basename(relative));
    return { root, absolute, info: await lstat(absolute).catch(() => null) };
  }

  /** Make an empty file or a folder; missing parent folders are made too. */
  async create(workspace, relative, kind) {
    if (!validProjectPath(relative)) throw new Error('That path is not inside the project.');
    const parts = relative.split('/');
    // Each parent is made in turn, so a link partway down cannot lead outside the project.
    for (let depth = 1; depth < parts.length; depth++) {
      const { absolute, info } = await this.locate(workspace, parts.slice(0, depth).join('/'));
      if (!info) await mkdir(absolute);
      else if (!(await stat(absolute)).isDirectory()) throw new Error(`${parts[depth - 1]} is a file, not a folder.`);
    }
    const { absolute, info } = await this.locate(workspace, relative);
    if (info) throw new Error(`${path.basename(absolute)} already exists.`);
    if (kind === 'directory') await mkdir(absolute);
    else await writeFile(absolute, '', { flag: 'wx', mode: 0o644 });
    return { path: relative, kind };
  }

  /** Rename or move a file or folder within the project; an existing destination is never replaced. */
  async rename(workspace, from, to) {
    if (from === to) return { path: to };
    if (to.startsWith(`${from}/`)) throw new Error('A folder cannot be moved inside itself.');
    const source = await this.locate(workspace, from);
    if (!source.info) throw new Error(`${path.basename(from)} no longer exists.`);
    const target = await this.locate(workspace, to);
    // On a case-insensitive disk a case-only rename finds the source itself at the destination.
    const sameFile = target.info && target.info.ino === source.info.ino && target.info.dev === source.info.dev && from.toLowerCase() === to.toLowerCase();
    if (target.info && !sameFile) throw new Error(`${path.basename(to)} already exists.`);
    await rename(source.absolute, target.absolute);
    return { path: to };
  }

  /** Move a file or folder to the system trash; a link is removed, not what it points to. */
  async remove(workspace, relative) {
    if (!this.trash) throw new Error('Deleting files is not available here.');
    const { absolute, info } = await this.locate(workspace, relative);
    if (!info) throw new Error(`${path.basename(relative)} no longer exists.`);
    await this.trash(absolute);
    return { path: relative };
  }

  /**
   * Every file in the project, for quick open: what git tracks plus untracked
   * files it does not ignore, or a walk of the folder outside a repository.
   */
  async index(workspace) {
    const root = await this.root(workspace);
    const listed = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { limit: 32 * 1024 * 1024 });
    if (listed) {
      const files = [];
      // A conflicted file is listed once per stage.
      for (const file of new Set(listed.output.toString('utf8').split('\0'))) {
        if (!file || file.split('/').some(part => HIDDEN.has(part))) continue;
        files.push(file);
        if (files.length >= MAX_INDEX_FILES) break;
      }
      // A deleted file stays in the index until it is staged; quick open leaves it out.
      const present = [];
      for (let start = 0; start < files.length; start += 256) {
        const batch = files.slice(start, start + 256);
        const found = await Promise.all(batch.map(file => lstat(path.join(root, file)).then(info => !info.isDirectory(), () => false)));
        batch.forEach((file, index) => { if (found[index]) present.push(file); });
      }
      return { files: present, truncated: listed.truncated || files.length >= MAX_INDEX_FILES };
    }
    const files = [];
    await walk(root, '', files);
    return { files, truncated: files.length >= MAX_INDEX_FILES };
  }

  /**
   * Find text across the project with git grep, which skips ignored and
   * binary files; outside a repository the files are read one by one.
   */
  async search(workspace, query, { caseSensitive = false, wholeWord = false, regex = false } = {}) {
    const root = await this.root(workspace);
    if (!query) return { matches: [], truncated: false };
    let pattern;
    try { pattern = new RegExp(regex ? query : escapeRegExp(query), caseSensitive ? 'g' : 'gi'); }
    catch { throw new Error('That regular expression is not valid.'); }
    const args = ['grep', '-z', '-n', '-I', '--untracked', '--exclude-standard', '--no-color'];
    if (!caseSensitive) args.push('-i');
    if (wholeWord) args.push('-w');
    // Git's extended regex lacks JavaScript's classes like \d; Perl syntax is closer when git has it.
    args.push(regex ? '-P' : '-F', '-e', query, '--');
    let found = await git(root, args, { okCodes: [0, 1] });
    if (!found && regex) found = await git(root, args.map(arg => arg === '-P' ? '-E' : arg), { okCodes: [0, 1] });
    if (!found) return walkSearch(root, pattern, wholeWord);
    const matches = [];
    let output = found.output.toString('utf8');
    // A capped read can stop partway through a line; only whole lines are kept.
    if (found.truncated) output = output.slice(0, output.lastIndexOf('\n') + 1);
    for (const line of output.split('\n')) {
      const [file, number, ...rest] = line.split('\0');
      if (!file || !number || file.split('/').some(part => HIDDEN.has(part))) continue;
      matches.push(...matchesIn(file, Number(number), rest.join('\0'), pattern, wholeWord));
      if (matches.length >= MAX_SEARCH_MATCHES) break;
    }
    return { matches: matches.slice(0, MAX_SEARCH_MATCHES), truncated: found.truncated || matches.length >= MAX_SEARCH_MATCHES };
  }

  /** The file as git last staged it, to mark the lines changed since; null when git does not have it. */
  async base(workspace, relative) {
    const { root } = await this.resolve(workspace, relative);
    const shown = await git(root, ['show', `:./${relative}`], { limit: MAX_EDIT_BYTES + 1 });
    if (!shown || shown.truncated || shown.output.subarray(0, 8192).includes(0)) return { path: relative, text: null };
    return { path: relative, text: shown.output.toString('utf8') };
  }
}

async function walk(root, relative, files) {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (files.length >= MAX_INDEX_FILES) return;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(root, child, files); }
    else if (entry.isFile() && !HIDDEN.has(entry.name)) files.push(child);
  }
}

const wordAt = (text, index) => index >= 0 && index < text.length && /\w/.test(text[index]);
/** Each occurrence on one line, with its 1-based column and a preview trimmed around it. */
function matchesIn(file, line, text, pattern, wholeWord) {
  const matches = [];
  pattern.lastIndex = 0;
  for (let found; (found = pattern.exec(text)) && matches.length < 50;) {
    if (!found[0]) { pattern.lastIndex++; continue; }
    const end = found.index + found[0].length;
    if (wholeWord && (wordAt(text, found.index - 1) || wordAt(text, end))) continue;
    const start = Math.max(0, found.index - 60);
    const preview = text.slice(start, start + MAX_PREVIEW_CHARS);
    matches.push({ path: file, line, column: found.index + 1, length: found[0].length, preview: (start ? '…' : '') + preview, offset: found.index - start + (start ? 1 : 0) });
  }
  return matches;
}

async function walkSearch(root, pattern, wholeWord) {
  const files = [];
  await walk(root, '', files);
  const matches = [];
  for (const file of files) {
    const bytes = await readFile(path.join(root, file)).catch(() => null);
    if (!bytes || bytes.length > MAX_EDIT_BYTES || bytes.subarray(0, 8192).includes(0)) continue;
    const lines = bytes.toString('utf8').split('\n');
    for (let index = 0; index < lines.length && matches.length < MAX_SEARCH_MATCHES; index++) matches.push(...matchesIn(file, index + 1, lines[index].replace(/\r$/, ''), pattern, wholeWord));
    if (matches.length >= MAX_SEARCH_MATCHES) return { matches: matches.slice(0, MAX_SEARCH_MATCHES), truncated: true };
  }
  return { matches, truncated: false };
}
