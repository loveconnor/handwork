import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, truncate, symlink } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareAttachmentFiles } from '../../electron/attachment-files.mjs';
import { backupRelativePath, relocateAttachmentEvents } from '../../electron/backup-attachments.mjs';
import { BackupService, backupEntry, scanBackup } from '../../electron/backup.mjs';
import { ChatPreferences } from '../../electron/chat-preferences.mjs';
import { SavedPrompts } from '../../electron/saved-prompts.mjs';
import { DesktopSettings } from '../../electron/desktop-settings.mjs';
import { ModelPreferences } from '../../electron/model-preferences.mjs';
import { ProjectStore } from '../../electron/project-store.mjs';
import { DraftStore } from '../../electron/draft-store.mjs';
import { QueueStore } from '../../electron/queue-store.mjs';
import { validateArguments } from '../../electron/ipc.mjs';
import { restoreSummary } from '../../lib/backup-summary.ts';

/** A Handwork profile in a temporary folder: engine home plus desktop app data. */
async function profile(root) {
  const home = path.join(root, 'home');
  const data = path.join(root, 'app');
  const sessionDirectory = path.join(home, '.handwork', 'sessions');
  const chatDirectory = path.join(data, 'chats');
  const attachmentDirectory = path.join(data, 'attachments');
  await mkdir(sessionDirectory, { recursive: true });
  const stores = {
    chatPreferences: new ChatPreferences(path.join(data, 'chat-preferences.json')),
    savedPrompts: new SavedPrompts(path.join(data, 'saved-prompts.json')),
    settings: new DesktopSettings(path.join(data, 'desktop-settings.json')),
    modelPreferences: new ModelPreferences(path.join(data, 'model-preferences.json')),
    projects: new ProjectStore(path.join(data, 'projects.json')),
    drafts: new DraftStore(path.join(data, 'drafts')),
    queues: new QueueStore(path.join(data, 'queues')),
  };
  return { home, data, sessionDirectory, chatDirectory, attachmentDirectory, ...stores, service: new BackupService({ sessionDirectory, chatDirectory, attachmentDirectory, home, appVersion: '9.9.9', ...stores }) };
}

async function session(directory, id, metadata, events = '{"schema_version":2,"seq":1,"timestamp_ms":1,"event":{"user":{"text":"hello"}}}\n') {
  const folder = path.join(directory, id);
  await mkdir(path.join(folder, 'logs'), { recursive: true });
  await mkdir(path.join(folder, 'tool-results'), { recursive: true });
  await writeFile(path.join(folder, 'session.json'), JSON.stringify({ schema_version: 4, id, ...metadata }));
  await writeFile(path.join(folder, 'events.jsonl'), events);
  await writeFile(path.join(folder, 'session.lock'), '');
  await writeFile(path.join(folder, 'logs', 'engine.log'), 'diagnostic noise');
  await writeFile(path.join(folder, 'tool-results', 'result.txt'), 'tool output');
  await writeFile(path.join(folder, '.session.json.tmp.0123'), 'half written');
}

async function filled(root) {
  const source = await profile(root);
  const project = path.join(root, 'project');
  await mkdir(project);
  const standalone = 'b1a2c3d4-0000-4000-8000-000000000001';
  await session(source.sessionDirectory, 'projectChat1', { workspace_root: project, origin_workspace_root: project, title: 'Project work' });
  await session(source.sessionDirectory, 'standalone01', { workspace_root: path.join(source.chatDirectory, standalone), origin_workspace_root: path.join(source.chatDirectory, standalone) });
  await session(source.sessionDirectory, 'childAgent01', { workspace_root: project, subagent_child: true });
  await mkdir(path.join(source.chatDirectory, standalone, 'attachments'), { recursive: true });
  await writeFile(path.join(source.chatDirectory, standalone, 'attachments', 'report.pdf'), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));
  await mkdir(source.attachmentDirectory, { recursive: true });
  await writeFile(path.join(source.attachmentDirectory, '5d0c.zip'), Buffer.from([1, 2, 3]));
  // Credentials and engine settings live beside the sessions and must never be read.
  await writeFile(path.join(source.home, '.handwork', 'chatgpt-auth.json'), '{"token":"SECRET-TOKEN"}');
  await writeFile(path.join(source.home, '.handwork', 'settings.json'), '{"apiKey":"SECRET-KEY"}');
  await writeFile(path.join(source.home, '.handwork', 'AGENTS.md'), 'Prefer short answers.');
  source.chatPreferences.write({ projectChat1: { title: 'Renamed', pinned: true, archived: true }, standalone01: { branch: { from: 'projectChat1', turn: 0, at: 1 } } });
  source.savedPrompts.save({ title: 'Review', text: 'Review {{file}}' });
  source.settings.update('app', { theme: 'dark', uiFontSize: 16 });
  source.settings.update('project', { defaultMode: 'ask' }, project);
  source.settings.saveStartup({ tabs: [{ id: 'projectChat1', label: 'Project work', workspace: project }], active: 'projectChat1' });
  source.modelPreferences.setFavorite('codex', 'fast-model', 'Fast', true);
  source.projects.add(project);
  source.projects.add(path.join(root, 'missing-project'));
  source.drafts.save('projectChat1', 'Half-written reply', [{ name: 'a.txt', mimeType: 'text/plain', size: 3, text: 'abc' }]);
  source.queues.save('standalone01', { paused: false, items: [{ id: 'q1', text: 'Queued follow-up', files: [{ name: 'p.png', mimeType: 'image/png', size: 4, data: Buffer.from('png!').toString('base64') }] }] });
  return { source, project, standalone };
}

test('a full backup restores chats, attachments, prompts, preferences, versions, and unsent work, without credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-backup-'));
  try {
    const { source, project, standalone } = await filled(path.join(root, 'a'));
    await mkdir(path.join(root, 'b'));
    const file = path.join(root, 'Handwork.handwork-backup');
    const created = await source.service.create(file);
    assert.equal(created.chats, 2, 'subagent sessions travel with their parent chat but are not counted');

    const raw = gunzipSync(await readFile(file)).toString('utf8');
    assert.doesNotMatch(raw, /SECRET/, 'credentials and engine settings are never included');
    const paths = [];
    await scanBackup(file, record => { if (record.kind === 'file') paths.push(record.path); });
    assert.ok(paths.includes('sessions/projectChat1/session.lock'), 'the engine expects its lock files');
    assert.ok(!paths.some(item => item.includes('/logs/') || item.includes('.tmp.')), 'logs and half-written files are left out');
    assert.ok(paths.includes(`chats/${standalone}/attachments/report.pdf`));
    assert.ok(paths.includes('attachments/5d0c.zip'));

    // Restore on a different computer, where the app keeps its data somewhere else.
    const target = await profile(path.join(root, 'b'));
    const preview = await target.service.preview(file);
    assert.equal(preview.appVersion, '9.9.9');
    assert.deepEqual(preview.chats, { total: 2, new: 2 });
    assert.deepEqual(preview.prompts, { total: 1, new: 1 });
    assert.deepEqual(preview.projects, { total: 2, available: 1 });
    assert.deepEqual(preview.unsent, { drafts: 1, queued: 1 });
    assert.equal(preview.attachments, 2);
    assert.deepEqual(await readdir(target.sessionDirectory), [], 'previewing writes nothing');

    const result = await target.service.restore(preview.token, { chats: true, prompts: true, preferences: true, unsent: true });
    assert.deepEqual(result, { chats: 2, attachments: 2, prompts: 1, projects: 1, drafts: 1, queued: 1, preferences: true, skippedChats: 0, skippedDrafts: 0, skippedQueued: 0 });
    assert.deepEqual((await readdir(target.sessionDirectory)).sort(), ['childAgent01', 'projectChat1', 'standalone01']);
    assert.equal(await readFile(path.join(target.sessionDirectory, 'projectChat1', 'events.jsonl'), 'utf8'), await readFile(path.join(source.sessionDirectory, 'projectChat1', 'events.jsonl'), 'utf8'));
    // Windows stat modes do not represent directory access permissions.
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(target.sessionDirectory, 'projectChat1'))).mode & 0o077, 0, 'restored history is private');
    }
    // Standalone chats point at this app's private chat folder.
    const moved = JSON.parse(await readFile(path.join(target.sessionDirectory, 'standalone01', 'session.json'), 'utf8'));
    assert.equal(moved.workspace_root, path.join(target.chatDirectory, standalone));
    assert.deepEqual([...await readFile(path.join(target.chatDirectory, standalone, 'attachments', 'report.pdf'))], [0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    assert.deepEqual([...await readFile(path.join(target.attachmentDirectory, '5d0c.zip'))], [1, 2, 3]);
    // Names, pins, archive state, and version links come back.
    assert.deepEqual(target.chatPreferences.list(), source.chatPreferences.list());
    assert.deepEqual(target.savedPrompts.list().map(prompt => prompt.title), ['Review']);
    assert.deepEqual(target.projects.list(), [project], 'only projects found on this computer are added');
    const settings = target.settings.snapshot(project);
    assert.equal(settings.app.theme, 'dark');
    assert.equal(settings.effective.defaultMode, 'ask');
    assert.deepEqual(target.settings.startup(), { tabs: [], active: '' }, 'startup tabs stay local');
    assert.deepEqual(target.modelPreferences.list().favorites.map(item => item.model), ['fast-model']);
    assert.equal(await readFile(path.join(target.home, '.handwork', 'AGENTS.md'), 'utf8'), 'Prefer short answers.');
    assert.deepEqual(target.drafts.list().map(draft => [draft.id, draft.text, draft.files[0].text]), [['projectChat1', 'Half-written reply', 'abc']]);
    const [queue] = target.queues.list();
    assert.equal(queue.paused, true, 'restored queues wait for review');
    assert.equal(queue.items[0].files[0].data, Buffer.from('png!').toString('base64'));
    assert.match(restoreSummary(result), /^Restored 2 chats, 1 saved prompt, 1 project, 1 draft, 1 queued message and your preferences\. Queued messages are paused/);
    assert.deepEqual((await readdir(path.join(root, 'b', 'home', '.handwork'))).filter(name => name.startsWith('.handwork-restore')), [], 'staging is cleaned up');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('restoring keeps chats and data already here, and only restores the chosen parts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-backup-merge-'));
  try {
    const { source } = await filled(path.join(root, 'a'));
    const file = path.join(root, 'backup.handwork-backup');
    await source.service.create(file);
    // Restoring into the same profile after more work: the newer local chat wins.
    await writeFile(path.join(source.sessionDirectory, 'projectChat1', 'events.jsonl'), 'newer local history\n');
    source.chatPreferences.update('projectChat1', { title: 'Newer name' });
    await rm(path.join(source.sessionDirectory, 'standalone01'), { recursive: true });
    source.settings.update('app', { theme: 'light' });
    const preview = await source.service.preview(file);
    assert.deepEqual(preview.chats, { total: 2, new: 1 });
    const result = await source.service.restore(preview.token, { chats: true, preferences: false });
    assert.equal(result.chats, 1);
    assert.equal(result.skippedChats, 1);
    assert.equal(await readFile(path.join(source.sessionDirectory, 'projectChat1', 'events.jsonl'), 'utf8'), 'newer local history\n');
    assert.equal(source.chatPreferences.list().projectChat1.title, 'Newer name');
    assert.equal(source.settings.snapshot().app.theme, 'light', 'preferences were not chosen');
    await assert.rejects(source.service.restore(preview.token, { chats: true }), /Choose the backup again/, 'a preview restores once');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('damaged, altered, or unrelated files are rejected before anything is restored', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-backup-bad-'));
  try {
    const { source } = await filled(path.join(root, 'a'));
    const target = await profile(path.join(root, 'b'));
    const file = path.join(root, 'good.handwork-backup');
    await source.service.create(file);

    const truncated = path.join(root, 'truncated.handwork-backup');
    const lines = gunzipSync(await readFile(file)).toString('utf8').trimEnd().split('\n');
    await writeFile(truncated, gzipSync(lines.slice(0, -1).join('\n') + '\n'));
    await assert.rejects(target.service.preview(truncated), /not a Handwork backup, or it is damaged/);

    const altered = path.join(root, 'altered.handwork-backup');
    const fileLine = lines.findIndex(line => line.includes('"kind":"file"'));
    const record = JSON.parse(lines[fileLine]);
    record.data = Buffer.from('tampered').toString('base64');
    record.size = 8;
    await writeFile(altered, gzipSync([...lines.slice(0, fileLine), JSON.stringify(record), ...lines.slice(fileLine + 1)].join('\n') + '\n'));
    await assert.rejects(target.service.preview(altered), /damaged/);

    const escape = path.join(root, 'escape.handwork-backup');
    record.path = 'sessions/../../outside.txt';
    await writeFile(escape, gzipSync([...lines.slice(0, fileLine), JSON.stringify(record), ...lines.slice(fileLine + 1)].join('\n') + '\n'));
    await assert.rejects(target.service.preview(escape), /damaged/);

    const plain = path.join(root, 'notes.handwork-backup');
    await writeFile(plain, 'just text');
    await assert.rejects(target.service.preview(plain), /not a Handwork backup/);

    const cut = path.join(root, 'cut.handwork-backup');
    await writeFile(cut, await readFile(file));
    await truncate(cut, Math.floor((await stat(cut)).size / 2));
    await assert.rejects(target.service.preview(cut), /damaged/);
    assert.deepEqual(await readdir(target.sessionDirectory), []);

    // A backup that changes between preview and restore is checked again.
    const preview = await target.service.preview(file);
    await writeFile(file, await readFile(truncated));
    await assert.rejects(target.service.restore(preview.token, { chats: true }), /changed after it was checked/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('archive paths can only name history, chat folders, and saved attachments', () => {
  assert.deepEqual(backupEntry('sessions/abcd1234/tool-results/x.txt'), { root: 'sessions', id: 'abcd1234', relative: 'tool-results/x.txt' });
  assert.equal(backupEntry('attachments/5d0c.zip').root, 'attachments');
  for (const bad of ['sessions/../x/y', '/etc/passwd', 'sessions/abcd1234', 'sessions/ab/x', 'chats/not-a-uuid/x', 'attachments/a/b', 'settings.json', 'sessions/abcd1234/./x', 'sessions\\abcd1234\\x', 'sessions/abcd1234//x']) {
    assert.equal(backupEntry(bad), null, bad);
  }
  assert.doesNotThrow(() => validateArguments('restoreBackup', ['0f0e8a2c-1b6d-4a3e-9c1f-2d3e4f5a6b7c', { chats: true, unsent: false }]));
  assert.throws(() => validateArguments('restoreBackup', ['0f0e8a2c-1b6d-4a3e-9c1f-2d3e4f5a6b7c', { credentials: true }]), /argument 2/);
  assert.throws(() => validateArguments('restoreBackup', ['/tmp/file', { chats: true }]), /argument 1/);
  assert.doesNotThrow(() => validateArguments('createBackup', []));
});

test('restore fills available unsent slots without evicting any local drafts or queues', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-backup-capacity-'));
  try {
    const source = await profile(path.join(root, 'source'));
    for (let i = 0; i < 3; i++) {
      source.drafts.save(`incoming-${i}`, `incoming draft ${i}`, []);
      source.queues.save(`incoming-${i}`, { paused: false, items: [0, 1].map(n => ({ id: `item-${n}`, text: `incoming ${i}/${n}`, files: [] })) });
    }
    // An overlap is kept rather than counted as overflow.
    source.drafts.save('local-0', 'older draft', []);
    source.queues.save('local-0', { paused: true, items: [{ id: 'older', text: 'older queue', files: [] }] });
    const file = path.join(root, 'capacity.handwork-backup');
    await source.service.create(file);
    for (const size of [199, 200]) {
      const target = await profile(path.join(root, `target-${size}`));
      const attachment = { name: 'keep.txt', mimeType: 'text/plain', size: 16, text: 'local attachment' };
      target.drafts.save('local-0', 'local draft', [attachment]);
      target.queues.save('local-0', { paused: false, items: [{ id: 'keep', text: 'local queue', files: [attachment] }] });
      const drafts = target.drafts.read(); const queues = target.queues.read();
      for (let i = 1; i < size; i++) {
        drafts[`local-${i}`] = { text: `local draft ${i}`, files: [], updatedAt: i };
        queues[`local-${i}`] = { paused: false, items: [{ id: 'keep', text: `local queue ${i}`, files: [], queuedAt: i }], updatedAt: i };
      }
      target.drafts.write(drafts); target.queues.write(queues);
      const beforeDrafts = target.drafts.read(); const beforeQueues = target.queues.read();
      const preview = await target.service.preview(file);
      assert.deepEqual(preview.unsent, { drafts: 3, queued: 6 });
      const result = await target.service.restore(preview.token, { unsent: true });
      const slots = 200 - size;
      assert.equal(result.drafts, slots);
      assert.equal(result.queued, slots * 2);
      assert.equal(result.skippedDrafts, 3 - slots);
      assert.equal(result.skippedQueued, (3 - slots) * 2);
      assert.match(restoreSummary(result), new RegExp(`Skipped ${3 - slots} drafts and ${(3 - slots) * 2} queued messages`));
      assert.equal(target.drafts.list().length, 200);
      assert.equal(target.queues.list().length, 200);
      for (const [key, value] of Object.entries(beforeDrafts)) assert.deepEqual(target.drafts.read()[key], value);
      for (const [key, value] of Object.entries(beforeQueues)) assert.deepEqual(target.queues.read()[key], value);
      assert.deepEqual(target.drafts.list().find(item => item.id === 'local-0').files, [attachment]);
      assert.deepEqual(target.queues.list().find(item => item.sessionId === 'local-0').items[0].files, [attachment]);
      assert.ok(target.queues.list().filter(item => item.sessionId.startsWith('incoming-')).every(item => item.paused));
      // Normal interactive saves still use the existing eviction policy.
      target.drafts.save('normal-new', 'normal draft', []);
      target.queues.save('normal-new', { paused: false, items: [{ id: 'normal', text: 'normal queue', files: [] }] });
      assert.equal(target.drafts.list().length, 200);
      assert.equal(target.queues.list().length, 200);
      assert.ok(target.drafts.list().some(item => item.id === 'normal-new'));
      assert.ok(target.queues.list().some(item => item.sessionId === 'normal-new'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('restored history relocates only archived binary attachment references in user events', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-backup-relocate-'));
  try {
    for (const style of ['native', 'windows', 'unc']) {
      const source = await profile(path.join(root, style, 'source space % # ü'));
      const target = await profile(path.join(root, style, 'target space % # 文'));
      const standalone = 'b1a2c3d4-0000-4000-8000-000000000001';
      const [projectFile] = await prepareAttachmentFiles([{ name: 'project.zip', mimeType: 'application/zip', data: 'AQID' }], source.attachmentDirectory);
      const [standaloneFile] = await prepareAttachmentFiles([{ name: 'standalone.pdf', mimeType: 'application/pdf', data: 'BAUG' }], path.join(source.chatDirectory, standalone, 'attachments'));
      const sourceRoots = style === 'native' ? { chatDirectory: source.chatDirectory, attachmentDirectory: source.attachmentDirectory }
        : { chatDirectory: `${style === 'windows' ? 'C:\\Users\\Source' : '\\\\server\\share'}\\space % # ü\\chats`, attachmentDirectory: `${style === 'windows' ? 'D:\\Profile' : '\\\\server\\share'}\\space % # ü\\attachments` };
      const asSource = (item, standaloneItem) => {
        if (style === 'native') return item;
        const nativePath = new URL(item.uri).pathname;
        const filename = decodeURIComponent(nativePath.split('/').at(-1));
        const local = path.win32.join(standaloneItem ? sourceRoots.chatDirectory : sourceRoots.attachmentDirectory, ...(standaloneItem ? [standalone, 'attachments', filename] : [filename]));
        const uri = style === 'windows' ? `file:///${local.replaceAll('\\', '/').split('/').map((part, i) => i ? encodeURIComponent(part) : part).join('/')}`
          : `file://server/${local.slice('\\\\server\\'.length).split('\\').map(encodeURIComponent).join('/')}`;
        return { ...item, uri, text: item.text.replace(/^Local copy: .*$/m, `Local copy: ${local}`) };
      };
      const projectRef = asSource(projectFile, false); const standaloneRef = asSource(standaloneFile, true);
      const block = item => `File: ${item.uri}\n${item.text}`;
      const prose = `Explain this path ${projectRef.uri} and Local copy: ${sourceRoots.attachmentDirectory}\n`;
      const code = `\n\n\x60\x60\x60text\n${block(projectRef)}\n\x60\x60\x60\n`;
      const notArchived = block(projectRef).replaceAll(new URL(projectRef.uri).pathname.split('/').at(-1), 'missing.zip');
      const text = `${prose}${code}\n${block(projectRef)}\n${block(standaloneRef)}\n${notArchived}`;
      const events = [
        { schema_version: 2, seq: 1, event: { user: { text } } },
        { schema_version: 2, seq: 2, event: { assistant: { text } } },
        { schema_version: 2, seq: 3, event: { tool: { text, path: projectRef.uri } } },
      ];
      const history = events.map(JSON.stringify).join('\n') + '\n';
      await session(source.sessionDirectory, 'attachment01', { workspace_root: style === 'native' ? path.join(source.chatDirectory, standalone) : path.win32.join(sourceRoots.chatDirectory, standalone) }, history);
      await session(source.sessionDirectory, 'existing0001', {}, history);
      await session(target.sessionDirectory, 'existing0001', {}, history);
      await writeFile(path.join(source.sessionDirectory, 'attachment01', 'tool-results', 'result.txt'), text);
      const file = path.join(root, `${style}.handwork-backup`);
      await source.service.create(file);
      if (style !== 'native') {
        // Model a backup produced on Windows without needing Windows to run this test.
        const lines = gunzipSync(await readFile(file)).toString('utf8').trimEnd().split('\n');
        const header = JSON.parse(lines[0]); header.source = sourceRoots;
        lines[0] = JSON.stringify(header);
        await writeFile(file, gzipSync(lines.join('\n') + '\n'));
      }
      const preview = await target.service.preview(file);
      assert.deepEqual(preview.chats, { total: 2, new: 1 });
      const result = await target.service.restore(preview.token, { chats: true });
      assert.equal(result.chats, 1); assert.equal(result.skippedChats, 1);
      const restored = (await readFile(path.join(target.sessionDirectory, 'attachment01', 'events.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
      const expectedRef = (item, isStandalone) => {
        const filename = decodeURIComponent(new URL(item.uri).pathname.split('/').at(-1));
        const local = isStandalone ? path.join(target.chatDirectory, standalone, 'attachments', filename) : path.join(target.attachmentDirectory, filename);
        return { ...item, uri: pathToFileURL(local).href, text: item.text.replace(/^Local copy: .*$/m, `Local copy: ${local}`) };
      };
      assert.equal(restored[0].event.user.text, `${prose}${code}\n${block(expectedRef(projectRef, false))}\n${block(expectedRef(standaloneRef, true))}\n${notArchived}`);
      assert.deepEqual(restored.slice(1), events.slice(1), 'assistant text and tool data stay unchanged');
      assert.equal(await readFile(path.join(target.sessionDirectory, 'existing0001', 'events.jsonl'), 'utf8'), history);
      assert.equal(await readFile(path.join(target.sessionDirectory, 'attachment01', 'tool-results', 'result.txt'), 'utf8'), text);
      const metadata = JSON.parse(await readFile(path.join(target.sessionDirectory, 'attachment01', 'session.json'), 'utf8'));
      assert.equal(metadata.workspace_root, path.join(target.chatDirectory, standalone));
      assert.deepEqual([...await readFile(path.join(target.attachmentDirectory, path.basename(new URL(projectFile.uri).pathname)))], [1, 2, 3]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('byte-limited restore skips whole drafts and queues without losing attachments or local work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-backup-bytes-'));
  try {
    const source = await profile(path.join(root, 'source'));
    const target = await profile(path.join(root, 'target'));
    const fileOf = text => ({ name: `${text}.txt`, mimeType: 'text/plain', size: text.length, text });
    for (const [id, text] of [['file-only', ''], ['mixed', 'keep my text']]) {
      source.drafts.save(id, text, [fileOf('ab'), fileOf('12345')]);
      source.queues.save(id, { paused: false, items: [{ id: 'fits', text: 'first', files: [fileOf('ab')] }, { id: 'fails', text, files: [fileOf('12345')] }] });
    }
    target.drafts.save('local', 'local', [fileOf('keep')]);
    target.queues.save('local', { paused: false, items: [{ id: 'local', text: 'local', files: [fileOf('keep')] }] });
    target.drafts.blobs.limit = 8; target.queues.blobs.limit = 8;
    const before = [target.drafts.list(), target.queues.list()];
    const backup = path.join(root, 'bytes.handwork-backup');
    await source.service.create(backup);
    const original = await readFile(backup);
    const preview = await target.service.preview(backup);
    const result = await target.service.restore(preview.token, { unsent: true });
    assert.equal(result.drafts, 0); assert.equal(result.queued, 0);
    assert.equal(result.skippedDrafts, 2); assert.equal(result.skippedQueued, 4);
    assert.deepEqual([target.drafts.list(), target.queues.list()], before);
    assert.equal(target.drafts.blobs.bytes(), 4); assert.equal(target.queues.blobs.bytes(), 4);
    assert.deepEqual(await readFile(backup), original);
    assert.match(restoreSummary(result), /Nothing new to restore.*Skipped 2 drafts and 4 queued messages.*remains in the backup/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('existing private chat folders merge missing attachments and preserve collisions for imported links', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-backup-folder-'));
  try {
    const source = await profile(path.join(root, 'source'));
    const target = await profile(path.join(root, 'target'));
    const id = 'b1a2c3d4-0000-4000-8000-000000000001';
    const folder = path.join(source.chatDirectory, id, 'attachments');
    await mkdir(folder, { recursive: true });
    const block = local => `File: ${pathToFileURL(local).href}\nAttached file: file.pdf\nType: application/pdf\nLocal copy: ${local}\nBinary attachment: inspect this file with a suitable local tool.`;
    const files = [path.join(folder, 'missing.pdf'), path.join(folder, 'collision.pdf'), path.join(source.attachmentDirectory, 'collision.zip')];
    await mkdir(source.attachmentDirectory, { recursive: true });
    for (const file of files) await writeFile(file, 'archived bytes');
    const history = JSON.stringify({ event: { user: { text: files.map(block).join('\n') } } }) + '\n';
    await session(source.sessionDirectory, 'newSession01', { workspace_root: path.dirname(folder) }, history);
    await session(source.sessionDirectory, 'existing0001', {}, history);
    await session(target.sessionDirectory, 'existing0001', {}, 'local history\n');
    const localFolder = path.join(target.chatDirectory, id, 'attachments');
    await mkdir(localFolder, { recursive: true });
    await mkdir(target.attachmentDirectory, { recursive: true });
    await writeFile(path.join(localFolder, 'collision.pdf'), 'local bytes');
    await writeFile(path.join(localFolder, 'local-only.pdf'), 'local only');
    await writeFile(path.join(target.attachmentDirectory, 'collision.zip'), 'local zip');
    const backup = path.join(root, 'merge.handwork-backup');
    await source.service.create(backup);
    const preview = await target.service.preview(backup);
    const result = await target.service.restore(preview.token, { chats: true });
    assert.equal(result.chats, 1); assert.equal(result.attachments, 2);
    assert.equal(await readFile(path.join(localFolder, 'collision.pdf'), 'utf8'), 'local bytes');
    assert.equal(await readFile(path.join(localFolder, 'local-only.pdf'), 'utf8'), 'local only');
    assert.equal(await readFile(path.join(target.attachmentDirectory, 'collision.zip'), 'utf8'), 'local zip');
    const imported = JSON.parse(await readFile(path.join(target.sessionDirectory, 'newSession01', 'events.jsonl'), 'utf8')).event.user.text;
    const locals = [...imported.matchAll(/^Local copy: (.+)$/gm)].map(match => match[1]);
    assert.equal(locals.length, 3);
    for (const local of locals) {
      assert.equal(await readFile(local, 'utf8'), 'archived bytes');
      assert.ok(imported.includes(`File: ${pathToFileURL(local).href}`));
    }
    assert.equal(locals[0], path.join(localFolder, 'missing.pdf'));
    assert.notEqual(locals[1], path.join(localFolder, 'collision.pdf'));
    assert.equal(await readFile(path.join(target.sessionDirectory, 'existing0001', 'events.jsonl'), 'utf8'), 'local history\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('attachment merge refuses local symlink folders without writing outside the destination', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-backup-symlink-'));
  try {
    const source = await profile(path.join(root, 'source'));
    const target = await profile(path.join(root, 'target'));
    const id = 'b1a2c3d4-0000-4000-8000-000000000001';
    await mkdir(path.join(source.chatDirectory, id, 'attachments'), { recursive: true });
    await writeFile(path.join(source.chatDirectory, id, 'attachments', 'report.pdf'), 'archived');
    await session(source.sessionDirectory, 'newSession01', { workspace_root: path.join(source.chatDirectory, id) });
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'report.pdf'), 'original');
    await mkdir(path.join(target.chatDirectory, id), { recursive: true });
    await symlink(outside, path.join(target.chatDirectory, id, 'attachments'), 'dir');
    const backup = path.join(root, 'symlink.handwork-backup');
    await source.service.create(backup);
    const preview = await target.service.preview(backup);
    await assert.rejects(target.service.restore(preview.token, { chats: true }), /symbolic link/);
    assert.equal(await readFile(path.join(outside, 'report.pdf'), 'utf8'), 'original');
    assert.deepEqual(await readdir(outside), ['report.pdf']);
    assert.deepEqual(await readdir(target.sessionDirectory), []);
    assert.deepEqual((await readdir(path.dirname(target.sessionDirectory))).filter(name => name.startsWith('.handwork-restore-')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('attachment relocation rejects traversal, prefix collisions, and malformed file URIs', () => {
  assert.deepEqual(backupRelativePath('C:\\Profile\\chats', 'c:\\profile\\chats\\chat-1\\attachments\\x.pdf'), ['chat-1', 'attachments', 'x.pdf']);
  for (const value of ['/source/attachments-other/x.pdf', '/source/attachments/../x.pdf', '/source/attachments/x\0.pdf']) {
    assert.equal(backupRelativePath('/source/attachments', value), null);
  }
  assert.equal(backupRelativePath('C:\\Profile\\attachments', 'D:\\Profile\\attachments\\x.pdf'), null);
  const roots = [{ source: '/source/attachments', destination: '/target space/attachments', archive: 'attachments' }];
  const archived = new Set(['attachments/x.pdf']);
  for (const uri of [
    'file:///source/attachments/%2e%2e/attachments/x.pdf',
    'file:///source/attachments/folder/../x.pdf',
    'file:///source/attachments%2fx.pdf',
    'file:///source/attachments%5cx.pdf',
    'file:///source/attachments/x.pdf#fragment',
    'file:///source/attachments/%zz',
    'file:///source/attachments-other/x.pdf',
  ]) {
    const text = `File: ${uri}\nAttached file: x.pdf\nType: application/pdf\nLocal copy: /source/attachments/x.pdf\nBinary attachment: inspect this file with a suitable local tool.`;
    const line = JSON.stringify({ event: { user: { text } } });
    assert.equal(relocateAttachmentEvents(line, roots, archived), line, uri);
  }
  assert.equal(relocateAttachmentEvents('not json\n', roots, archived), 'not json\n');
});
