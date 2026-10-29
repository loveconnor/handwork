import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, statSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectFiles, validProjectPath, MAX_EDIT_BYTES } from '../../electron/project-files.mjs';
import { validateArguments } from '../../electron/ipc.mjs';

function project() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'project-files-')));
  const outside = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'outside-')));
  mkdirSync(path.join(root, 'src/lib'), { recursive: true });
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, 'README.md'), '# Hi\n');
  writeFileSync(path.join(root, 'src/app.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'src/file10.ts'), '');
  writeFileSync(path.join(root, 'src/file2.ts'), '');
  writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
  symlinkSync(path.join(root, 'src'), path.join(root, 'src-link'));
  return { root, outside };
}

test('paths from the renderer are project-relative and cannot climb out', () => {
  for (const ok of ['a', 'src/app.ts', '.env', 'a b/c']) assert.ok(validProjectPath(ok), ok);
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a/./b', 'a//b', 'C:/x', 'a\\b', 'a\0b']) assert.ok(!validProjectPath(bad), JSON.stringify(bad));
  assert.ok(validProjectPath('', { allowRoot: true }));
});

test('listing hides tooling state and links that leave the project, folders first in natural order', async () => {
  const { root } = project();
  const files = new ProjectFiles();
  const top = await files.list(root, '');
  assert.deepEqual(top.entries.map(entry => `${entry.kind[0]}:${entry.path}`), ['d:src', 'd:src-link', 'f:logo.png', 'f:README.md']);
  const src = await files.list(root, 'src');
  assert.deepEqual(src.entries.map(entry => entry.name), ['lib', 'app.ts', 'file2.ts', 'file10.ts']);
});

test('reads return text with a revision; binary, oversized and escaping files are refused or flagged', async () => {
  const { root } = project();
  const files = new ProjectFiles();
  const text = await files.read(root, 'src/app.ts');
  assert.equal(text.text, 'export const a = 1;\n');
  assert.match(text.revision, /^[a-f0-9]{64}$/);
  const binary = await files.read(root, 'logo.png');
  assert.equal(binary.binary, true); assert.equal(binary.text, null);
  writeFileSync(path.join(root, 'big.log'), Buffer.alloc(MAX_EDIT_BYTES + 1, 97));
  assert.equal((await files.read(root, 'big.log')).tooLarge, true);
  await assert.rejects(files.read(root, 'escape.txt'), /outside the project/);
  await assert.rejects(files.read(root, '../x'), /not inside the project/);
  await assert.rejects(files.read(root, 'src'), /not a file/);
});

test('saves are atomic, keep the file mode, and refuse to overwrite a change made on disk', async () => {
  const { root } = project();
  const files = new ProjectFiles();
  const file = path.join(root, 'src/app.ts');
  chmodSync(file, 0o755);
  // Windows exposes read/write attributes rather than POSIX executable bits.
  const originalMode = statSync(file).mode & 0o777;
  const opened = await files.read(root, 'src/app.ts');
  const saved = await files.write(root, 'src/app.ts', 'export const a = 2;\n', opened.revision);
  assert.equal(readFileSync(file, 'utf8'), 'export const a = 2;\n');
  assert.equal(statSync(file).mode & 0o777, originalMode);
  assert.notEqual(saved.revision, opened.revision);
  assert.ok(!readdirSync(path.join(root, 'src')).some(name => name.endsWith('.handwork-tmp')), 'no temporary file is left behind');
  // Someone else edits the file; a save from the stale revision is refused and changes nothing.
  writeFileSync(file, 'changed elsewhere\n');
  await assert.rejects(files.write(root, 'src/app.ts', 'mine\n', saved.revision), error => error.code === 'CONFLICT');
  assert.equal(readFileSync(file, 'utf8'), 'changed elsewhere\n');
  // A new file is written from a null revision, and only once.
  await files.write(root, 'src/new.ts', 'new\n', null);
  await assert.rejects(files.write(root, 'src/new.ts', 'again\n', null), error => error.code === 'CONFLICT');
  await assert.rejects(files.write(root, 'escape.txt', 'x', null), /outside the project/);
});

test('file IPC accepts only project paths, bounded text and real revisions', () => {
  validateArguments('listProjectFiles', ['/w', '']);
  validateArguments('readProjectFile', ['/w', 'src/a.ts']);
  validateArguments('writeProjectFile', ['/w', 'src/a.ts', 'x', null]);
  validateArguments('writeProjectFile', ['/w', 'src/a.ts', 'x', 'a'.repeat(64)]);
  for (const [method, args] of [['readProjectFile', ['/w', '']], ['readProjectFile', ['/w', '../a']], ['writeProjectFile', ['/w', 'a', 'x', 'rev']], ['writeProjectFile', ['/w', 'a', 1, null]], ['listProjectFiles', ['/w', '/etc']]])
    assert.throws(() => validateArguments(method, args), /Invalid desktop API arguments/, `${method} ${JSON.stringify(args)}`);
});

test('entries the project ignores are flagged, and a failed lookup leaves the tree as it is', async () => {
  const { root } = project();
  const asked = [];
  const files = new ProjectFiles({ ignored: async (base, paths) => { asked.push([base, paths]); return new Set(['logo.png']); } });
  const listing = await files.list(root, '');
  assert.deepEqual(listing.entries.filter(entry => entry.ignored).map(entry => entry.path), ['logo.png']);
  assert.equal(asked[0][0], root);
  const broken = new ProjectFiles({ ignored: async () => { throw new Error('not a git repository'); } });
  assert.ok((await broken.list(root, '')).entries.every(entry => !entry.ignored));
});
