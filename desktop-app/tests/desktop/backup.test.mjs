import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, truncate } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    assert.deepEqual(result, { chats: 2, attachments: 2, prompts: 1, projects: 1, drafts: 1, queued: 1, preferences: true, skippedChats: 0 });
    assert.deepEqual((await readdir(target.sessionDirectory)).sort(), ['childAgent01', 'projectChat1', 'standalone01']);
    assert.equal(await readFile(path.join(target.sessionDirectory, 'projectChat1', 'events.jsonl'), 'utf8'), await readFile(path.join(source.sessionDirectory, 'projectChat1', 'events.jsonl'), 'utf8'));
    assert.equal((await stat(path.join(target.sessionDirectory, 'projectChat1'))).mode & 0o077, 0, 'restored history is private');
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
