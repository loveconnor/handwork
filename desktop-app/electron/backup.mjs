import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import path from 'node:path';
import { MAX_QUEUED } from './queue-store.mjs';
import { backupRelativePath, relocateAttachmentEvents } from './backup-attachments.mjs';

export const BACKUP_FORMAT = 'handwork-backup';
export const BACKUP_EXTENSION = 'handwork-backup';
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const SESSION_ID = /^[\w-]{4,64}$/;
const CHAT_ID = /^[a-f0-9-]{36}$/;
// Half-written files are left out. Lock files are kept: they are empty and the engine expects them.
const SKIPPED_FILE = /\.tmp$|^\..*\.tmp\./;
// Engine logs are diagnostics, not conversation history.
const SKIPPED_FOLDER = new Set(['logs']);
export const RESTORE_CATEGORIES = ['chats', 'prompts', 'preferences', 'unsent'];

const notBackup = () => new Error('This file is not a Handwork backup, or it is damaged.');

/**
 * Where an archived file belongs: an engine session, a standalone chat folder, or a
 * saved attachment. Anything else, including `..` or absolute paths, is rejected.
 */
export function backupEntry(archivePath) {
  if (typeof archivePath !== 'string' || archivePath.length > 1024 || /[\x00-\x1f\\]/.test(archivePath) || path.posix.normalize(archivePath) !== archivePath) return null;
  const parts = archivePath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  if (parts[0] === 'sessions' && parts.length >= 3 && SESSION_ID.test(parts[1])) return { root: 'sessions', id: parts[1], relative: parts.slice(2).join('/') };
  if (parts[0] === 'chats' && parts.length >= 3 && CHAT_ID.test(parts[1])) return { root: 'chats', id: parts[1], relative: parts.slice(2).join('/') };
  if (parts[0] === 'attachments' && parts.length === 2) return { root: 'attachments', id: parts[1], relative: parts[1] };
  return null;
}

/** Regular files below a folder, skipping symlinks, locks, temporary files, and logs. */
async function* walk(directory, prefix) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, entry.name);
    const archived = `${prefix}/${entry.name}`;
    if (entry.isDirectory() && !SKIPPED_FOLDER.has(entry.name)) yield* walk(absolute, archived);
    else if (entry.isFile() && !SKIPPED_FILE.test(entry.name)) yield { absolute, archived };
  }
}

/** Every file a full backup contains, as archive path and source path. */
export async function* backupFiles({ sessionDirectory, chatDirectory, attachmentDirectory }) {
  for (const [root, directory, valid] of [['sessions', sessionDirectory, SESSION_ID], ['chats', chatDirectory, CHAT_ID]]) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && valid.test(entry.name)) yield* walk(path.join(directory, entry.name), `${root}/${entry.name}`);
    }
  }
  for await (const file of walk(attachmentDirectory, 'attachments')) if (backupEntry(file.archived)) yield file;
}

/** Writes a gzip-compressed JSON-lines backup atomically: header, records, files, end marker. */
export async function writeBackup(destination, header, records, files) {
  const temporary = `${destination}.handwork-${randomUUID()}.tmp`;
  const gzip = createGzip({ level: 6 });
  const finished = pipeline(gzip, createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
  finished.catch(() => {});
  const write = async value => { if (!gzip.write(JSON.stringify(value) + '\n')) await Promise.race([once(gzip, 'drain'), finished]); };
  let count = 0; let bytes = 0;
  try {
    await write({ ...header, format: BACKUP_FORMAT, version: 1 });
    for (const record of records) await write(record);
    for await (const file of files) {
      const info = await lstat(file.absolute).catch(() => null);
      // Files that disappear or grow too large while the backup runs are left out.
      if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
      const data = await readFile(file.absolute);
      await write({ kind: 'file', path: file.archived, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), mtime: info.mtimeMs, data: data.toString('base64') });
      count++; bytes += data.length;
    }
    await write({ kind: 'end', files: count, bytes });
    gzip.end();
    await finished;
    await rename(temporary, destination);
    return { files: count, bytes };
  } catch (error) {
    gzip.destroy();
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function* lines(file) {
  const gunzip = createGunzip();
  const source = createReadStream(file);
  source.on('error', error => gunzip.destroy(error));
  source.pipe(gunzip);
  const reader = createInterface({ input: gunzip, crlfDelay: Infinity });
  try {
    for await (const line of reader) if (line) yield line;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EACCES') throw error;
    throw notBackup();
  } finally { reader.close(); source.destroy(); gunzip.destroy(); }
}

/**
 * Reads and verifies a whole backup. `visit` receives each record and each file entry
 * after its checksum passes. Throws if the file is truncated or altered.
 */
export async function scanBackup(file, visit = () => {}) {
  let header; let count = 0; let bytes = 0; let ended = false;
  for await (const line of lines(file)) {
    let value;
    try { value = JSON.parse(line); } catch { throw notBackup(); }
    if (!header) {
      if (value?.format !== BACKUP_FORMAT) throw notBackup();
      if (value.version !== 1) throw new Error('This backup was made by a newer version of Handwork. Update Handwork, then try again.');
      header = value;
      continue;
    }
    if (ended) throw notBackup();
    if (value?.kind === 'end') {
      if (value.files !== count || value.bytes !== bytes) throw notBackup();
      ended = true;
      continue;
    }
    if (value?.kind === 'file') {
      const entry = backupEntry(value.path);
      if (!entry || typeof value.data !== 'string') throw notBackup();
      const data = Buffer.from(value.data, 'base64');
      if (data.length !== value.size || createHash('sha256').update(data).digest('hex') !== value.sha256) throw notBackup();
      count++; bytes += data.length;
      await visit({ kind: 'file', entry, path: value.path, data });
      continue;
    }
    if (value?.kind === 'draft' || value?.kind === 'queue') { await visit(value); continue; }
    throw notBackup();
  }
  if (!header || !ended) throw notBackup();
  return { header, files: count, bytes };
}

/** Moves a staged folder or file into place, copying when it is on another volume. */
async function move(from, to) {
  await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
  try { await rename(from, to); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    await rm(from, { recursive: true, force: true });
  }
}

const exists = target => lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const validAttachment = file => file && typeof file === 'object' && typeof file.name === 'string' && typeof file.mimeType === 'string' && (typeof file.data === 'string' || typeof file.text === 'string');
const validMessage = item => item && typeof item.text === 'string' && Array.isArray(item.files) && item.files.every(validAttachment);
const draftKey = value => typeof value === 'string' && value.length <= 512 && /^[a-zA-Z0-9_.:-]+$/.test(value);

/**
 * Full backups of chats, attachments, saved prompts, preferences, archive state,
 * version links, drafts, and queued messages. Provider credentials and engine
 * settings are never read, so they are never included.
 */
export class BackupService {
  constructor({ sessionDirectory, chatDirectory, attachmentDirectory, home, chatPreferences, savedPrompts, settings, modelPreferences, projects, drafts, queues, appVersion = '0.0.0' }) {
    Object.assign(this, { sessionDirectory, chatDirectory, attachmentDirectory, home, chatPreferences, savedPrompts, settings, modelPreferences, projects, drafts, queues, appVersion });
    this.pending = null;
  }

  get instructionsFile() { return this.home ? path.join(this.home, '.handwork', 'AGENTS.md') : null; }

  async create(destination) {
    const sessions = await this.chatSummaries(this.sessionDirectory);
    const settings = this.settings.read();
    const drafts = this.drafts.list();
    const queues = this.queues.list();
    const instructions = this.instructionsFile ? await readFile(this.instructionsFile, 'utf8').catch(() => '') : '';
    const prompts = this.savedPrompts.list();
    const projects = this.projects.list();
    const header = {
      createdAt: Date.now(), appVersion: this.appVersion, platform: process.platform,
      source: { chatDirectory: this.chatDirectory, attachmentDirectory: this.attachmentDirectory },
      summary: { chats: sessions.length, prompts: prompts.length, projects: projects.length, drafts: drafts.length, queued: queues.reduce((total, queue) => total + queue.items.length, 0) },
      data: {
        chatPreferences: this.chatPreferences.list(), savedPrompts: prompts, projects, instructions,
        settings: { app: settings.app ?? {}, projects: settings.projects ?? {} },
        modelPreferences: (() => { try { return this.modelPreferences.list(); } catch { return { favorites: [], usage: [] }; } })(),
      },
    };
    const records = [...drafts.map(value => ({ kind: 'draft', value })), ...queues.map(value => ({ kind: 'queue', value }))];
    const written = await writeBackup(destination, header, records, backupFiles(this));
    return { path: destination, chats: sessions.length, files: written.files, bytes: written.bytes };
  }

  /** Top-level chats in a sessions folder; subagent work belongs to its parent chat. */
  async chatSummaries(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const chats = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
      let metadata = {};
      try { metadata = JSON.parse(await readFile(path.join(directory, entry.name, 'session.json'), 'utf8')); } catch { /* Counted without a title. */ }
      if (metadata.subagent_child !== true) chats.push(entry.name);
    }
    return chats;
  }

  /** Verifies a backup and describes what restoring it would add. Nothing is written. */
  async preview(file) {
    const info = await stat(file);
    const sessions = new Map(); const chatFolders = new Set(); const attachments = new Set();
    const drafts = []; const queues = [];
    const { header } = await scanBackup(file, record => {
      if (record.kind === 'draft' && draftKey(record.value?.id)) drafts.push(record.value.id);
      else if (record.kind === 'queue' && draftKey(record.value?.sessionId) && Array.isArray(record.value.items)) queues.push({ id: record.value.sessionId, count: record.value.items.length });
      else if (record.kind === 'file') {
        const { root, id, relative } = record.entry;
        if (root === 'sessions') {
          const session = sessions.get(id) ?? { child: false };
          if (relative === 'session.json') { try { session.child = JSON.parse(record.data.toString('utf8')).subagent_child === true; } catch { /* Counted as a chat. */ } }
          sessions.set(id, session);
        } else if (root === 'chats') chatFolders.add(id);
        else attachments.add(id);
      }
    });
    const chats = [...sessions].filter(([, session]) => !session.child).map(([id]) => id);
    const existing = new Set(await readdir(this.sessionDirectory).catch(() => []));
    const localDrafts = new Set(this.drafts.list().map(draft => draft.id));
    const localQueues = new Set(this.queues.list().map(queue => queue.sessionId));
    const localPrompts = new Set(this.savedPrompts.list().map(prompt => prompt.id));
    const data = header.data && typeof header.data === 'object' ? header.data : {};
    const prompts = Array.isArray(data.savedPrompts) ? data.savedPrompts : [];
    const projects = Array.isArray(data.projects) ? data.projects.filter(value => typeof value === 'string' && path.isAbsolute(value)) : [];
    const available = [];
    for (const project of projects) if (await stat(project).then(item => item.isDirectory(), () => false)) available.push(project);
    const newQueues = queues.filter(queue => !localQueues.has(queue.id));
    const token = randomUUID();
    this.pending = { token, file, size: info.size, mtime: info.mtimeMs };
    return {
      token, fileName: path.basename(file), size: info.size,
      createdAt: Number(header.createdAt) || 0, appVersion: typeof header.appVersion === 'string' ? header.appVersion : '',
      chats: { total: chats.length, new: chats.filter(id => !existing.has(id)).length },
      attachments: attachments.size + chatFolders.size,
      prompts: { total: prompts.length, new: prompts.filter(prompt => !localPrompts.has(prompt?.id)).length },
      projects: { total: projects.length, available: available.length },
      unsent: { drafts: drafts.filter(id => !localDrafts.has(id)).length, queued: newQueues.reduce((total, queue) => total + queue.count, 0) },
      preferences: !!data.settings,
    };
  }

  /**
   * Restores the chosen parts of a previewed backup. Chats, prompts, drafts, and queues
   * already here are kept; chosen preferences replace the matching local ones.
   */
  async restore(token, categories) {
    const pending = this.pending;
    if (!pending || pending.token !== token) throw new Error('Choose the backup again to restore it.');
    const info = await stat(pending.file);
    if (info.size !== pending.size || info.mtimeMs !== pending.mtime) throw new Error('The backup changed after it was checked. Choose it again.');
    this.pending = null;
    const chosen = new Set(RESTORE_CATEGORIES.filter(category => categories[category] === true));
    if (!chosen.size) throw new Error('Choose at least one thing to restore.');
    const staging = path.join(path.dirname(this.sessionDirectory), `.handwork-restore-${randomUUID()}`);
    const existingSessions = new Set(await readdir(this.sessionDirectory).catch(() => []));
    const drafts = []; const queues = [];
    const result = { chats: 0, attachments: 0, prompts: 0, projects: 0, drafts: 0, queued: 0, preferences: false, skippedChats: 0, skippedDrafts: 0, skippedQueued: 0 };
    const skipped = new Set();
    try {
      const { header } = await scanBackup(pending.file, async record => {
        if (record.kind === 'draft') { if (chosen.has('unsent')) drafts.push(record.value); return; }
        if (record.kind === 'queue') { if (chosen.has('unsent')) queues.push(record.value); return; }
        const { root, id, relative } = record.entry;
        if (!chosen.has('chats')) return;
        // A chat already on this computer keeps its local copy.
        if (root === 'sessions' && existingSessions.has(id)) { skipped.add(id); return; }
        const target = path.join(staging, root, root === 'attachments' ? id : path.join(id, ...relative.split('/')));
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, record.data, { mode: 0o600, flag: 'wx' });
      });
      const data = header.data && typeof header.data === 'object' ? header.data : {};
      if (chosen.has('chats')) {
        Object.assign(result, await this.placeChats(staging, header));
        result.skippedChats = (await this.chatSummariesFrom(skipped)).length;
        result.projects = await this.restoreProjects(data.projects);
        this.restoreChatPreferences(data.chatPreferences);
      }
      if (chosen.has('prompts')) result.prompts = this.savedPrompts.merge(Array.isArray(data.savedPrompts) ? data.savedPrompts : []);
      if (chosen.has('preferences')) result.preferences = await this.restorePreferences(data);
      if (chosen.has('unsent')) Object.assign(result, this.restoreUnsent(drafts, queues));
      return result;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }

  async chatSummariesFrom(ids) {
    const chats = [];
    for (const id of ids) {
      try { if (JSON.parse(await readFile(path.join(this.sessionDirectory, id, 'session.json'), 'utf8')).subagent_child === true) continue; } catch { /* Counted as a chat. */ }
      chats.push(id);
    }
    return chats;
  }

  async placeChats(staging, header) {
    let chats = 0; let attachments = 0;
    const sourceChats = typeof header.source?.chatDirectory === 'string' ? header.source.chatDirectory : '';
    const roots = [
      { source: sourceChats, destination: this.chatDirectory, archive: 'chats' },
      { source: header.source?.attachmentDirectory, destination: this.attachmentDirectory, archive: 'attachments' },
    ];
    // Place files first so imported links point only at successfully placed bytes.
    const archived = new Map();
    for (const root of ['chats', 'attachments']) {
      const directory = root === 'chats' ? this.chatDirectory : this.attachmentDirectory;
      const added = new Set();
      await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
      for await (const file of walk(path.join(staging, root), root)) {
        const parts = file.archived.split('/').slice(1);
        const parent = path.join(directory, ...parts.slice(0, -1));
        // Never follow a local symlink while merging private folders.
        for (let i = 0; i < parts.length; i++) {
          const folder = path.join(directory, ...parts.slice(0, i));
          await mkdir(folder, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
          if (!(await lstat(folder)).isDirectory()) throw new Error('Cannot restore attachments through a non-directory or symbolic link.');
        }
        let target = path.join(parent, parts.at(-1));
        const data = await readFile(file.absolute);
        let placed = false;
        for (;;) {
          try { await writeFile(target, data, { flag: 'wx', mode: 0o600 }); placed = true; break; }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const info = await lstat(target);
            if (info.isFile() && (await readFile(target)).equals(data)) break;
            target = path.join(parent, `restored-${randomUUID()}${path.extname(parts.at(-1)).slice(0, 16)}`);
          }
        }
        archived.set(file.archived, target);
        if (placed) added.add(root === 'chats' ? parts[0] : file.archived);
      }
      attachments += added.size;
    }
    const stagedSessions = await readdir(path.join(staging, 'sessions')).catch(() => []);
    for (const id of stagedSessions) {
      const staged = path.join(staging, 'sessions', id);
      // Standalone chats ran in the backed-up app's private folder; point them at this one.
      const target = path.join(this.sessionDirectory, id);
      if (await exists(target)) continue;
      if (sourceChats) await this.relocateSession(path.join(staged, 'session.json'), sourceChats);
      // Work only on staged history. Existing local sessions are never rewritten.
      for await (const file of walk(staged, '')) {
        if (path.basename(file.absolute) !== 'events.jsonl') continue;
        const contents = await readFile(file.absolute, 'utf8');
        const relocated = relocateAttachmentEvents(contents, roots, archived);
        if (contents !== relocated) await writeFile(file.absolute, relocated, { mode: 0o600 });
      }
      await move(staged, target);
      try { if (JSON.parse(await readFile(path.join(target, 'session.json'), 'utf8')).subagent_child !== true) chats++; } catch { chats++; }
    }
    return { chats, attachments };
  }

  async relocateSession(file, sourceChats) {
    let metadata;
    try { metadata = JSON.parse(await readFile(file, 'utf8')); } catch { return; }
    let changed = false;
    for (const key of ['workspace_root', 'origin_workspace_root']) {
      const value = metadata[key];
      const relative = backupRelativePath(sourceChats, value);
      if (relative) {
        metadata[key] = path.join(this.chatDirectory, ...relative);
        changed = true;
      }
    }
    if (changed) await writeFile(file, JSON.stringify(metadata), { mode: 0o600 });
  }

  async restoreProjects(projects) {
    if (!Array.isArray(projects)) return 0;
    const known = new Set(this.projects.list());
    let added = 0;
    // Projects return only when their folder exists on this computer.
    for (const project of [...projects].reverse()) {
      if (typeof project !== 'string' || !path.isAbsolute(project) || project.includes('\0') || known.has(project)) continue;
      if (!await stat(project).then(item => item.isDirectory(), () => false)) continue;
      this.projects.add(project); known.add(project); added++;
    }
    return added;
  }

  restoreChatPreferences(preferences) {
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) return;
    const local = this.chatPreferences.list();
    const additions = Object.fromEntries(Object.entries(preferences).filter(([id, value]) => SESSION_ID.test(id) && !Object.hasOwn(local, id) && value && typeof value === 'object' && !Array.isArray(value)));
    if (Object.keys(additions).length) this.chatPreferences.write({ ...local, ...additions });
  }

  async restorePreferences(data) {
    let changed = false;
    if (data.settings && typeof data.settings === 'object') changed = this.settings.importPreferences(data.settings) || changed;
    if (data.modelPreferences && typeof data.modelPreferences === 'object') { try { this.modelPreferences.merge(data.modelPreferences); changed = true; } catch { /* Model shortcuts are optional. */ } }
    // App instructions are restored only where none exist yet.
    const file = this.instructionsFile;
    if (file && typeof data.instructions === 'string' && data.instructions.trim() && Buffer.byteLength(data.instructions) <= 65536 && !await exists(file)) {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, data.instructions, { mode: 0o600, flag: 'wx' });
      changed = true;
    }
    return changed;
  }

  restoreUnsent(drafts, queues) {
    let restoredDrafts = 0; let queued = 0; let skippedDrafts = 0; let skippedQueued = 0;
    const localDrafts = new Set(this.drafts.list().map(draft => draft.id));
    for (const draft of drafts) {
      if (!draftKey(draft?.id) || localDrafts.has(draft.id) || !validMessage(draft)) continue;
      if (!draft.text.trim() && !draft.files.length) continue;
      if (!this.drafts.save(draft.id, draft.text, draft.files, { evict: false }).saved) { skippedDrafts++; continue; }
      localDrafts.add(draft.id);
      restoredDrafts++;
    }
    const localQueues = new Set(this.queues.list().map(queue => queue.sessionId));
    for (const queue of queues) {
      if (!draftKey(queue?.sessionId) || localQueues.has(queue.sessionId) || !Array.isArray(queue.items)) continue;
      const valid = queue.items.filter(item => validMessage(item) && (item.text.trim() || item.files.length) && typeof item.id === 'string' && item.id.length <= 64);
      const items = valid.slice(0, MAX_QUEUED);
      if (!items.length) continue;
      // Restored queues wait for review before anything is sent. Never evict local work.
      if (!this.queues.save(queue.sessionId, { paused: true, items }, { evict: false }).saved) { skippedQueued += valid.length; continue; }
      localQueues.add(queue.sessionId);
      skippedQueued += valid.length - items.length;
      queued += items.length;
    }
    return { drafts: restoredDrafts, queued, skippedDrafts, skippedQueued };
  }
}
