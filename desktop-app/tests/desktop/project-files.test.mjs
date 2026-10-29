import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, statSync, readFileSync, readdirSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

function repository() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'project-repo-')));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });
  try { git('init', '-q'); } catch { return null; }
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'node_modules'));
  writeFileSync(path.join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(path.join(root, 'src/app.ts'), 'const Foo = 1;\nfoo(Foo, food);\n');
  writeFileSync(path.join(root, 'node_modules/dep.js'), 'foo\n');
  writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x66, 0x6f, 0x6f, 0x00]));
  git('add', '.');
  git('commit', '-qm', 'start');
  writeFileSync(path.join(root, 'notes.md'), 'foo is untracked\n');
  writeFileSync(path.join(root, 'src/app.ts'), 'const Foo = 2;\nfoo(Foo, food);\n');
  return root;
}

test('new files and folders are made with their parents, never over something that exists, and never outside', async () => {
  const { root } = project();
  const files = new ProjectFiles();
  assert.deepEqual(await files.create(root, 'src/new/deep/one.ts', 'file'), { path: 'src/new/deep/one.ts', kind: 'file' });
  assert.equal(readFileSync(path.join(root, 'src/new/deep/one.ts'), 'utf8'), '');
  await files.create(root, 'docs', 'directory');
  assert.ok(statSync(path.join(root, 'docs')).isDirectory());
  await assert.rejects(files.create(root, 'README.md', 'file'), /already exists/);
  await assert.rejects(files.create(root, 'README.md/inner.ts', 'file'), /is a file, not a folder/);
  await assert.rejects(files.create(root, '../out.ts', 'file'), /not inside the project/);
  // A link that leads out of the project cannot be made into a folder to write through.
  await assert.rejects(files.create(root, 'escape.txt/x', 'file'));
});

test('renames move files and folders within the project, allow a change of case, and never replace a file', async () => {
  const { root, outside } = project();
  const files = new ProjectFiles();
  await files.rename(root, 'src/app.ts', 'src/lib/main.ts');
  assert.ok(existsSync(path.join(root, 'src/lib/main.ts')) && !existsSync(path.join(root, 'src/app.ts')));
  await files.rename(root, 'src/lib/main.ts', 'src/lib/Main.ts');
  assert.ok(readdirSync(path.join(root, 'src/lib')).includes('Main.ts'));
  await assert.rejects(files.rename(root, 'src/file2.ts', 'src/file10.ts'), /already exists/);
  await assert.rejects(files.rename(root, 'src', 'src/lib/src'), /inside itself/);
  await assert.rejects(files.rename(root, 'gone.ts', 'here.ts'), /no longer exists/);
  await assert.rejects(files.rename(root, 'src/file2.ts', 'missing/file2.ts'), /does not exist/);
  // A link is renamed itself; what it points to stays put.
  await files.rename(root, 'escape.txt', 'escape-2.txt');
  assert.ok(lstatSync(path.join(root, 'escape-2.txt')).isSymbolicLink());
  assert.equal(readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'nope');
});

test('deletes go to the trash, a link and not what it points to', async () => {
  const { root, outside } = project();
  const trashed = [];
  const files = new ProjectFiles({ trash: async target => { trashed.push(target); } });
  await files.remove(root, 'src');
  await files.remove(root, 'escape.txt');
  assert.deepEqual(trashed, [path.join(root, 'src'), path.join(root, 'escape.txt')]);
  assert.ok(existsSync(path.join(outside, 'secret.txt')));
  await assert.rejects(files.remove(root, 'nothing.txt'), /no longer exists/);
  await assert.rejects(new ProjectFiles().remove(root, 'README.md'), /not available/);
});

test('quick open lists tracked and untracked files git does not ignore, or walks a folder outside git', async () => {
  const root = repository();
  if (root) {
    const { files, truncated } = await new ProjectFiles().index(root);
    assert.deepEqual(files.sort(), ['.gitignore', 'logo.png', 'notes.md', 'src/app.ts']);
    assert.equal(truncated, false);
  }
  const plain = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'project-plain-')));
  mkdirSync(path.join(plain, 'node_modules/x'), { recursive: true });
  mkdirSync(path.join(plain, 'lib'));
  writeFileSync(path.join(plain, 'node_modules/x/i.js'), '');
  writeFileSync(path.join(plain, 'lib/a.js'), '');
  writeFileSync(path.join(plain, '.DS_Store'), '');
  assert.deepEqual((await new ProjectFiles().index(plain)).files, ['lib/a.js']);
});

test('search finds each occurrence with its line and column, honours case, words and expressions, and skips binaries', async () => {
  const root = repository();
  if (!root) return;
  const files = new ProjectFiles();
  const found = await files.search(root, 'foo');
  assert.deepEqual(found.matches.map(match => `${match.path}:${match.line}:${match.column}`), ['notes.md:1:1', 'src/app.ts:1:7', 'src/app.ts:2:1', 'src/app.ts:2:5', 'src/app.ts:2:10']);
  const first = found.matches[1];
  assert.equal(first.preview.slice(first.offset, first.offset + first.length), 'Foo');
  assert.deepEqual((await files.search(root, 'Foo', { caseSensitive: true })).matches.map(match => match.column), [7, 5]);
  assert.equal((await files.search(root, 'foo', { wholeWord: true })).matches.length, 4);
  assert.equal((await files.search(root, 'fo+d', { regex: true })).matches.length, 1);
  await assert.rejects(files.search(root, '(', { regex: true }), /not valid/);
});

test('the staged copy of a file backs its change bars; untracked files have none', async () => {
  const root = repository();
  if (!root) return;
  const files = new ProjectFiles();
  assert.equal((await files.base(root, 'src/app.ts')).text, 'const Foo = 1;\nfoo(Foo, food);\n');
  assert.equal((await files.base(root, 'notes.md')).text, null);
  assert.equal((await files.base(root, 'logo.png')).text, null);
});

test('IPC for making, renaming, deleting and searching takes only project paths and known options', () => {
  validateArguments('createProjectPath', ['/w', 'src/a.ts', 'file']);
  validateArguments('renameProjectPath', ['/w', 'a.ts', 'b/a.ts']);
  validateArguments('deleteProjectPath', ['/w', 'a']);
  validateArguments('indexProjectFiles', ['/w']);
  validateArguments('projectFileBase', ['/w', 'a.ts']);
  validateArguments('searchProjectFiles', ['/w', 'foo', { caseSensitive: true, wholeWord: false, regex: false }]);
  for (const [method, args] of [['createProjectPath', ['/w', 'a', 'link']], ['createProjectPath', ['/w', '../a', 'file']], ['renameProjectPath', ['/w', 'a', '']], ['deleteProjectPath', ['/w', '']],
    ['searchProjectFiles', ['/w', '', { caseSensitive: true, wholeWord: false, regex: false }]], ['searchProjectFiles', ['/w', 'x', { caseSensitive: 1, wholeWord: false, regex: false }]], ['searchProjectFiles', ['/w', 'x', { caseSensitive: true }]]])
    assert.throws(() => validateArguments(method, args), /Invalid desktop API arguments/, `${method} ${JSON.stringify(args)}`);
});
