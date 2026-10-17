import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, chmod, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DraftStore } from '../../electron/draft-store.mjs';
import { FileAccess, TrustedFiles } from '../../electron/file-access.mjs';
import { validateArguments } from '../../electron/ipc.mjs';
import { DesktopBackend } from '../../electron/backend.mjs';
import { applyUpdate, emptyConversation, splitUserText } from '../../lib/desktop-state.ts';

test('drafts survive a restart with their attachments, and sent drafts disappear', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-drafts-'));
  try {
    const image = { name: 'shot.png', mimeType: 'image/png', size: 4, data: Buffer.from('png!').toString('base64') };
    const note = { name: 'notes.md', mimeType: 'text/markdown', size: 5, text: 'hello', uri: 'file:///tmp/notes.md' };
    const store = new DraftStore(path.join(root, 'drafts'));
    store.save('chat-1', 'Half-written question', [image, note]);
    // Text-only saves keep the attachments already stored.
    store.save('chat-1', 'Half-written question, edited', null);
    store.save('chat-2', 'Another', [image]);

    const reopened = new DraftStore(path.join(root, 'drafts')).list();
    const first = reopened.find(draft => draft.id === 'chat-1');
    assert.equal(first.text, 'Half-written question, edited');
    assert.deepEqual(first.files.map(file => file.name), ['shot.png', 'notes.md']);
    assert.equal(first.files[0].data, image.data);
    assert.equal(first.files[1].text, 'hello');
    assert.equal(first.files[1].uri, note.uri);
    // The same image is stored once.
    assert.equal((await readdir(path.join(root, 'drafts', 'blobs'))).length, 2);

    store.save('chat-1', '', []);
    store.remove(['chat-2']);
    assert.deepEqual(store.list(), []);
    assert.equal((await readdir(path.join(root, 'drafts', 'blobs'))).length, 0, 'unused attachments are deleted');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('files open only inside allowed folders, never as apps or scripts, and can always be revealed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-files-'));
  try {
    const project = path.join(root, 'project');
    const outside = path.join(root, 'elsewhere');
    await mkdir(path.join(project, 'docs'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(project, 'docs', 'plan.md'), '# Plan\n');
    await writeFile(path.join(project, 'run.sh'), 'echo hi\n');
    await chmod(path.join(project, 'run.sh'), 0o755);
    await writeFile(path.join(project, 'pixel.png'), Buffer.from('89504e47', 'hex'));
    await writeFile(path.join(outside, 'secret.txt'), 'private');
    await writeFile(path.join(outside, 'picked.txt'), 'chosen');
    const opened = []; const revealed = [];
    const trusted = new TrustedFiles();
    const files = new FileAccess({ roots: () => [project], trusted, shell: { openPath: async file => { opened.push(file); return ''; }, showItemInFolder: file => revealed.push(file) } });

    const markdown = await files.preview('docs/plan.md', project);
    assert.equal(markdown.kind, 'text');
    assert.equal(markdown.mimeType, 'text/markdown');
    assert.equal(markdown.text, '# Plan\n');
    assert.equal((await files.preview(pathToFileURL(path.join(project, 'pixel.png')).href, project)).kind, 'image');
    await files.open('docs/plan.md', project);
    assert.equal(path.basename(opened[0]), 'plan.md');

    await assert.rejects(files.open('run.sh', project), /does not open apps or scripts/);
    await assert.rejects(files.preview('../elsewhere/secret.txt', project), /leaves the project/);
    const secret = await files.preview(path.join(outside, 'secret.txt'), project);
    assert.equal(secret.allowed, false);
    assert.equal(secret.text, undefined, 'files outside allowed folders are not read');
    await assert.rejects(files.open(path.join(outside, 'secret.txt'), project), /Reveal it/);
    await files.reveal(path.join(outside, 'secret.txt'), project);
    assert.equal(revealed.length, 1);

    // Files picked in the system dialog stay openable.
    trusted.add([path.join(outside, 'picked.txt')]);
    assert.equal((await files.preview(path.join(outside, 'picked.txt'), project)).text, 'chosen');
    await assert.rejects(files.preview(path.join(project, 'missing.txt'), project), /no longer exists/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('project roots and picked files use the same native path casing as previews', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-path-case-'));
  try {
    const project = path.join(root, 'MixedCaseProject');
    const picked = path.join(root, 'PickedNote.txt');
    await mkdir(project);
    await writeFile(path.join(project, 'Plan.md'), '# Plan\n');
    await writeFile(picked, 'chosen');
    // Windows resolves these inputs to the existing mixed-case paths. On other
    // platforms keep the exact spelling because filesystems may be case sensitive.
    const inputPath = file => process.platform === 'win32' ? file.toLowerCase() : file;
    const storePath = path.join(root, 'trusted.json');
    const trusted = new TrustedFiles(storePath);
    trusted.add([inputPath(picked)]);
    assert.deepEqual(trusted.list(), [await realpath(picked)]);
    const files = new FileAccess({ roots: () => [inputPath(project)], trusted: new TrustedFiles(storePath), shell: {} });
    const preview = await files.preview('Plan.md', inputPath(project));
    assert.equal(preview.allowed, true);
    assert.equal(preview.kind, 'text');
    assert.equal(preview.canOpen, true);
    assert.equal((await files.preview(inputPath(picked))).text, 'chosen');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('replayed history shows sent images and files as attachments, keeping the stored text for rewinds', () => {
  const raw = 'Compare these\n[Image #1]\nFile: file:///Users/me/report.csv\na,b\n1,2\nFile: file:///tmp/abc.pdf\nAttached file: Budget.pdf\nType: application/pdf';
  const split = splitUserText(raw);
  assert.equal(split.text, 'Compare these\n[Image #1]');
  assert.deepEqual(split.files.map(file => [file.name, file.uri]), [['report.csv', 'file:///Users/me/report.csv'], ['Budget.pdf', 'file:///tmp/abc.pdf']]);
  assert.deepEqual(splitUserText('No files here').files, []);

  let state = applyUpdate(emptyConversation(), { sessionUpdate: 'user_message_chunk', messageId: 'm1', content: { type: 'text', text: raw } });
  state = applyUpdate(state, { sessionUpdate: 'user_message_chunk', messageId: 'm1', content: { type: 'image', data: 'aGk=', mimeType: 'image/png' } });
  const [entry] = state.entries;
  assert.equal(entry.text, 'Compare these', 'image placeholders leave the visible text');
  assert.equal(entry.rawText, raw);
  assert.deepEqual(entry.attachments.map(file => file.name), ['report.csv', 'Budget.pdf', 'Image 1']);
  assert.equal(entry.attachments[2].data, 'aGk=');
  // A repeated image chunk is not added twice.
  assert.equal(applyUpdate(state, { sessionUpdate: 'user_message_chunk', messageId: 'm1', content: { type: 'image', data: 'aGk=', mimeType: 'image/png' } }).entries[0].attachments.length, 3);
});

test('IPC accepts draft and file requests only in their expected shapes', () => {
  validateArguments('saveDraft', ['chat-1', 'text', null]);
  validateArguments('saveDraft', ['chat-1', '', []]);
  validateArguments('removeDrafts', [['chat-1', 'chat-2']]);
  validateArguments('previewFile', ['src/app.ts']);
  assert.throws(() => validateArguments('saveDraft', ['../escape', 'text', null]), /Invalid desktop API/);
  assert.throws(() => validateArguments('saveDraft', ['chat-1', 'text', [{ name: 'x' }]]), /Invalid desktop API/);
  assert.throws(() => validateArguments('openFile', ['bad\npath']), /Invalid desktop API/);
  assert.throws(() => validateArguments('revealFile', ['']), /Invalid desktop API/);
});

test('notifications name the chat that finished or failed', async () => {
  const notices = [];
  let respond;
  const backend = new DesktopBackend({ notify: (kind, sessionId) => notices.push([kind, sessionId]), clientFactory: () => ({}) });
  const engine = { client: { closed: false, request: () => new Promise(resolve => { respond = resolve; }), cancelPermissions() {} }, session: { sessionId: 'chat-9' }, running: false };
  backend.engines.add(engine);
  const reply = backend.prompt('hello', [], 'chat-9');
  await new Promise(resolve => setImmediate(resolve));
  respond({ stopReason: 'end_turn' });
  await reply;
  assert.deepEqual(notices, [['complete', 'chat-9']]);
});
