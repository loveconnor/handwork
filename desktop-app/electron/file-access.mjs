import path from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync, realpathSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
const DOCUMENTS = { '.pdf': 'application/pdf' };
// Opening these with the system handler would run them instead of showing them.
const EXECUTABLE = new Set(['.app', '.command', '.tool', '.sh', '.bash', '.zsh', '.csh', '.fish', '.terminal', '.scpt', '.applescript', '.workflow', '.action', '.pkg', '.mpkg', '.dmg', '.jar', '.exe', '.bat', '.cmd', '.com', '.msi', '.msix', '.ps1', '.psm1', '.vbs', '.vbe', '.wsf', '.wsh', '.scr', '.lnk', '.reg', '.hta', '.cpl', '.url', '.desktop', ...(process.platform === 'win32' ? ['.js', '.jse'] : [])]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_TRUSTED = 2000;

const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
// Match fs/promises.realpath's native resolution, including Windows path casing.
// The JS realpathSync implementation can preserve input casing instead, making
// an allowed root or picked file differ from the path returned by describe().
const canonical = file => { try { return realpathSync.native(file); } catch { return path.resolve(file); } };

/** Files the person chose in the system file picker stay openable later. */
export class TrustedFiles {
  constructor(file) { this.file = file; this.memory = []; }
  list() {
    if (!this.file) return this.memory;
    try { const data = JSON.parse(readFileSync(this.file, 'utf8')); return Array.isArray(data) ? data.filter(item => typeof item === 'string') : []; }
    catch { return []; }
  }
  add(paths) {
    const next = [...new Set([...paths.map(canonical), ...this.list()])].slice(0, MAX_TRUSTED);
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file + '.tmp', JSON.stringify(next), { mode: 0o600 });
      renameSync(this.file + '.tmp', this.file);
    }
    this.memory = next;
  }
  has(file) { return this.list().includes(file); }
}

/**
 * Opens, reveals, and previews local files named by chat content.
 *
 * The renderer only names a file. Reading or opening it requires the file to be
 * inside a project, a Handwork attachment folder, or a file the person picked.
 * Revealing it in Finder or Explorer needs only an existing absolute path,
 * because that neither reads nor runs it.
 */
export class FileAccess {
  constructor({ roots, trusted = new TrustedFiles(), shell }) { this.roots = roots; this.trusted = trusted; this.shell = shell; }

  /** Accepts file:// URIs, absolute paths, and paths relative to the selected project. */
  resolve(target, workspace) {
    let file = target.trim();
    if (/^file:\/\//i.test(file)) {
      try { file = fileURLToPath(file); } catch { throw new Error('This file link is not valid.'); }
    } else if (file.startsWith('~/') && process.env.HOME) file = path.join(process.env.HOME, file.slice(2));
    if (!path.isAbsolute(file)) {
      if (!workspace) throw new Error('Open a project to use relative file paths.');
      file = path.resolve(workspace, file);
      if (!inside(file, path.resolve(workspace))) throw new Error('This path leaves the project folder.');
    }
    return path.normalize(file);
  }

  async describe(target, workspace) {
    const requested = this.resolve(target, workspace);
    const file = await realpath(requested).catch(error => { if (error.code === 'ENOENT') throw new Error(`${path.basename(requested)} no longer exists.`); throw error; });
    const info = await stat(file);
    const allowed = this.roots().some(root => root && inside(file, canonical(root))) || this.trusted.has(file);
    const extension = path.extname(file).toLowerCase();
    const executable = info.isDirectory() || EXECUTABLE.has(extension) || (process.platform !== 'win32' && info.isFile() && (info.mode & 0o111) !== 0);
    return { file, info, allowed, extension, executable };
  }

  async preview(target, workspace) {
    const { file, info, allowed, extension, executable } = await this.describe(target, workspace);
    const base = { name: path.basename(file), path: file, size: info.size, canOpen: allowed && info.isFile() && !executable, canReveal: true, allowed };
    if (!allowed || !info.isFile()) return { ...base, kind: 'other' };
    if (IMAGES[extension] && info.size <= MAX_IMAGE_BYTES) return { ...base, kind: 'image', mimeType: IMAGES[extension], data: (await readBounded(file, MAX_IMAGE_BYTES)).toString('base64') };
    if (DOCUMENTS[extension]) return { ...base, kind: 'other', mimeType: DOCUMENTS[extension] };
    const bytes = await readBounded(file, MAX_TEXT_BYTES);
    if (bytes.includes(0)) return { ...base, kind: 'other' };
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { ...base, kind: 'text', mimeType: extension === '.md' || extension === '.markdown' ? 'text/markdown' : 'text/plain', text, truncated: info.size > MAX_TEXT_BYTES };
    } catch { return { ...base, kind: 'other' }; }
  }

  async open(target, workspace) {
    const { file, info, allowed, executable } = await this.describe(target, workspace);
    if (!allowed) throw new Error('Handwork opens files in your projects, attachments, and files you picked. Reveal it to open it yourself.');
    if (!info.isFile() || executable) throw new Error('Handwork does not open apps or scripts. Reveal it to open it yourself.');
    const failure = await this.shell.openPath(file);
    if (failure) throw new Error(failure);
  }

  async reveal(target, workspace) {
    const { file } = await this.describe(target, workspace);
    this.shell.showItemInFolder(file);
  }
}

async function readBounded(file, limit) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
