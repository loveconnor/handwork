import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { realpath, lstat, readlink, open } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';

const exec = promisify(execFile);
const MAX_FILES = 250;
const MAX_FILE_BYTES = 1024 * 1024;
const inside = (root, target) => target === root || target.startsWith(root + path.sep);

async function git(cwd, args, maxBuffer = 8 * 1024 * 1024) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  const { stdout } = await exec('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'status.renames=false', '-C', cwd, ...args], { env, encoding: 'buffer', timeout: 10000, maxBuffer });
  return stdout.toString('utf8');
}

function numstats(output) {
  return new Map(output.split('\0').filter(Boolean).map(row => {
    const first = row.indexOf('\t'), second = row.indexOf('\t', first + 1);
    const added = row.slice(0, first), removed = row.slice(first + 1, second);
    return [row.slice(second + 1), { added: Number(added) || 0, removed: Number(removed) || 0, binary: added === '-' || removed === '-' }];
  }));
}

export async function untrackedText(project, file, budget = MAX_FILE_BYTES) {
  const parent = await realpath(path.dirname(file));
  if (!inside(project, parent)) throw new Error('This file is outside the selected project.');
  const info = await lstat(file);
  if (info.isSymbolicLink()) return { text: await readlink(file), bytes: info.size };
  if (!info.isFile()) return { note: 'This entry is not a regular file.', bytes: 0 };
  if (info.size > MAX_FILE_BYTES) return { note: 'File content exceeds the preview limit (1 MB per file).', bytes: 0 };
  if (info.size > budget) return { note: 'Snapshot size limit reached. Select this file to load its preview.', bytes: 0 };
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES, budget) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > Math.min(MAX_FILE_BYTES, budget)) return { note: 'File content exceeds the preview limit.', bytes: 0 };
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0) || !isUtf8(bytes)) return { binary: true, note: 'Binary file; no text preview.', bytes: bytesRead };
    return { text: bytes.toString('utf8'), bytes: bytesRead };
  } finally { await handle.close(); }
}

export class ProjectChangesReader {
  current = null;
  pending = new Map();

  snapshot(workspace) {
    const key = JSON.stringify(['snapshot', workspace]);
    if (this.pending.has(key)) return this.pending.get(key);
    const job = this.readSnapshot(workspace).finally(() => this.pending.delete(key));
    this.pending.set(key, job);
    return job;
  }

  async readSnapshot(workspace) {
    const empty = { workspace, files: [], totalFiles: 0, truncated: false, checkedAt: Date.now() };
    if (!workspace) { this.current = null; return { ...empty, kind: 'no-project' }; }
    const project = await realpath(workspace);
    let repository;
    try { repository = (await git(project, ['rev-parse', '--show-toplevel'])).trim(); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Git is unavailable. Install Git to review project changes.');
      if (String(error.stderr).includes('not a git repository')) { this.current = null; return { ...empty, kind: 'not-repository' }; }
      throw new Error('Could not read this Git repository. Check its availability and Git permissions.');
    }
    const scope = path.relative(repository, project).split(path.sep).join('/') || '.';
    const diffArgs = ['--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z'];
    const [status, staged, unstaged] = await Promise.all([
      git(repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', scope]),
      git(repository, ['diff', '--cached', ...diffArgs, '--', scope]),
      git(repository, ['diff', ...diffArgs, '--', scope]),
    ]);
    const index = numstats(staged), working = numstats(unstaged);
    const rows = status.split('\0').filter(Boolean);
    const allowed = new Map();
    const files = [];
    let budget = 4 * MAX_FILE_BYTES;
    for (const row of rows.slice(0, MAX_FILES)) {
      const gitPath = row.slice(3), absolute = path.resolve(repository, gitPath);
      if (!inside(project, absolute)) continue;
      const displayPath = path.relative(project, absolute).split(path.sep).join('/');
      const state = row.slice(0, 2), isUntracked = state === '??';
      const a = index.get(gitPath), b = working.get(gitPath);
      const file = { path: displayPath, status: state, staged: !isUntracked && state[0] !== ' ', unstaged: !isUntracked && state[1] !== ' ', untracked: isUntracked, added: (a?.added ?? 0) + (b?.added ?? 0), removed: (a?.removed ?? 0) + (b?.removed ?? 0), binary: !!(a?.binary || b?.binary), complete: true };
      if (isUntracked) {
        try {
          const content = await untrackedText(project, absolute, budget);
          budget -= content.bytes;
          file.binary = !!content.binary;
          file.complete = content.text !== undefined || !!content.binary;
          if (content.text) file.added = content.text.split('\n').length - (content.text.endsWith('\n') ? 1 : 0);
        } catch { file.complete = false; }
      }
      allowed.set(displayPath, { ...file, gitPath, absolute });
      files.push(file);
    }
    this.current = { workspace, project, repository, allowed };
    return { ...empty, kind: 'repository', files, totalFiles: rows.length, truncated: rows.length > MAX_FILES };
  }

  async file(workspace, displayPath, context = 3) {
    const snapshot = this.current;
    const file = snapshot?.workspace === workspace ? snapshot.allowed.get(displayPath) : null;
    if (!file) throw new Error('This file is no longer in the selected project changes. Refresh the list.');
    const sections = [];
    if (file.untracked) {
      try {
        const content = await untrackedText(snapshot.project, file.absolute);
        sections.push({ label: 'Untracked', text: content.text, note: content.note });
      } catch { throw new Error('This file changed or became unavailable. Refresh the project changes.'); }
    } else {
      for (const [enabled, label, stage] of [[file.staged, 'Staged', ['--cached']], [file.unstaged, 'Unstaged', []]]) {
        if (!enabled) continue;
        try {
          const patch = await git(snapshot.repository, ['diff', ...stage, '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--submodule=short', `--unified=${Math.max(0, Math.min(1000000, Math.trunc(Number(context) || 0)))}`, '--', file.gitPath], 2 * MAX_FILE_BYTES);
          sections.push({ label, patch, note: patch ? undefined : 'No diff is available. The file may have changed since the last refresh.' });
        } catch (error) {
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') sections.push({ label, note: 'This diff exceeds the 2 MB preview limit.' });
          else throw new Error('Could not read this diff. Refresh the project changes.');
        }
      }
    }
    return { workspace, path: displayPath, context, sections };
  }
}
