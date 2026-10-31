import { readFile, lstat, realpath, mkdir, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const revision = text => createHash('sha256').update(text).digest('hex');
export async function readInstructions(home, workspace, scope) {
  const file = scope === 'app' ? path.join(home, '.handwork', 'AGENTS.md') : path.join(workspace, 'AGENTS.md');
  if (scope === 'project' && !workspace) throw new Error('Open a project first');
  let text = '';
  try { const info = await lstat(file); if (!info.isFile() || info.size > 65536) throw new Error('Instructions must be a regular file under 64 KB'); text = await readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { text, revision: revision(text), path: file };
}
export async function saveInstructions(home, workspace, scope, text, expectedRevision) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 || text.includes('\0')) throw new Error('Instructions must be under 64 KB');
  const current = await readInstructions(home, workspace, scope);
  if (expectedRevision !== current.revision) throw new Error('Instructions changed in another editor. Reload them before saving.');
  await mkdir(path.dirname(current.path), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(current.path));
  const expected = scope === 'app' ? path.join(await realpath(home), '.handwork') : await realpath(workspace);
  if (parent !== expected) throw new Error('Instructions cannot be saved through a linked directory');
  const temporary = path.join(parent, `.handwork-instructions-${randomUUID()}.tmp`);
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, current.path); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return readInstructions(home, workspace, scope);
}
export async function enginePreferences(home, workspace) {
  let raw = {};
  try { raw = JSON.parse(await readFile(path.join(home, '.handwork', 'settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const canonical = workspace ? await realpath(workspace).catch(() => workspace) : '';
  const local = canonical && Object.hasOwn(raw.workspaces ?? {}, canonical) ? raw.workspaces[canonical] : {};
  return { global: raw.permission ?? {}, project: local.permission ?? {}, directories: local.additional_directories ?? [], path: path.join(home, '.handwork', 'settings.json') };
}
export async function attachmentUsage(directory) {
  let count = 0, bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (!entry.isFile()) continue;
    const info = await stat(path.join(directory, entry.name)); count++; bytes += info.size;
  }
  return { count, bytes, path: directory };
}
