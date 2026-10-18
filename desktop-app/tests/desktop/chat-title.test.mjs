import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chatTitle, isPlaceholderTitle } from '../../electron/chat-title.mjs';
import { ChatSearchIndex } from '../../electron/chat-search.mjs';
import { DesktopBackend } from '../../electron/backend.mjs';
import { ChatPreferences } from '../../electron/chat-preferences.mjs';
import { EventEmitter } from 'node:events';
import { applyUpdate, emptyConversation } from '../../lib/desktop-state.ts';

test('placeholder names become prompt previews, never timestamps', () => {
  for (const title of ['', undefined, 'New chat', 'Untitled', 'Untitled chat', 'Untitled session', 'Chat · 9:15 PM', 'Chat · Sep 13']) {
    assert.equal(isPlaceholderTitle(title), true);
    assert.equal(chatTitle(title, 'Explain pointers\n  in C'), 'Explain pointers in C');
    assert.equal(chatTitle(title), 'New chat');
  }
  assert.equal(chatTitle('Pointer basics', 'Explain pointers'), 'Pointer basics');
  const long = chatTitle('', 'Explain how pointers work in C and how to avoid memory errors when passing them between functions');
  assert.ok(long.length <= 73);
  assert.ok(long.endsWith('…'));
});

test('prompt titles exclude file contents and image placeholders', () => {
  assert.equal(chatTitle('', 'Review this\n[Image #1]\nFile: file:///tmp/secret.txt\nprivate content'), 'Review this');
  assert.equal(chatTitle('', '[Image #1]'), 'Image attachment');
  assert.equal(chatTitle('', 'File: attachment:///file.txt\nprivate content'), 'File attachment');
});

test('live generated titles survive restart, stale history, and replay without replacing custom names', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'handwork-live-title-'));
  const file = path.join(directory, 'preferences.json');
  const sessionId = 'generated001';
  const promptTitle = 'Reply with exactly AUDIT_OK. Do not use tools.';
  const titleUpdate = title => ({ sessionUpdate: 'session_info_update', title });
  const create = () => new DesktopBackend({
    settingsService: { home: directory }, chatPreferences: new ChatPreferences(file),
    clientFactory: () => {
      const client = new EventEmitter();
      let exit;
      client.exited = new Promise(resolve => { exit = resolve; });
      client.dispose = () => { client.closed = true; exit(); };
      client.request = async method => {
        if (method === 'initialize') return { protocolVersion: 1 };
        if (method === 'session/list') return { sessions: [{ sessionId, title: promptTitle, cwd: directory, turns: 1 }] };
        if (method === 'handwork/session/read') {
          client.emit('event', { method: 'handwork/session_read_update', params: { sessionId, update: titleUpdate(promptTitle) } });
          return { title: promptTitle, cwd: directory };
        }
        if (method === 'session/load') {
          client.emit('event', { method: 'session/update', params: { sessionId, update: titleUpdate(promptTitle) } });
          return { configOptions: [] };
        }
        throw new Error(`Unexpected method: ${method}`);
      };
      return client;
    },
  });
  let app = create();
  try {
    const engine = await app.openEngine(directory);
    engine.session = { sessionId, configOptions: [] };
    app.activate(engine);
    const update = (title, id = sessionId) => engine.client.emit('event', { method: 'session/update', params: { sessionId: id, update: titleUpdate(title) } });
    update('Audit Response Request');
    update(undefined); update('New chat'); update('Other chat', 'different001');
    assert.equal(app.chatPreferences.list()[sessionId].generatedTitle, 'Audit Response Request');
    assert.equal((await app.collectSessions()).sessions[0].title, 'Audit Response Request');
    await app.dispose();

    app = create();
    app.workspace = directory;
    assert.equal(app.listCachedSessions().sessions[0].title, 'Audit Response Request');
    assert.equal((await app.collectSessions()).sessions[0].title, 'Audit Response Request');
    const read = await app.readSession(sessionId);
    assert.equal(read.title, 'Audit Response Request');
    assert.equal(read.updates.reduce(applyUpdate, emptyConversation()).title, 'Audit Response Request');
    const replay = [];
    app.on('event', event => { if (event.method === 'session/update') replay.push(event.params.update); });
    await app.loadSession(sessionId);
    assert.equal(replay.reduce(applyUpdate, emptyConversation()).title, 'Audit Response Request');
    assert.equal(app.chatPreferences.list()[sessionId].generatedTitle, 'Audit Response Request', 'replayed prompt previews must not replace a saved generated title');

    app.chatPreferences.update(sessionId, { title: 'My custom name', pinned: true });
    app.rememberTitle(sessionId, 'New generated name');
    assert.equal((await app.collectSessions()).sessions[0].title, 'My custom name');
    assert.equal((await app.readSession(sessionId)).title, 'My custom name');
    assert.equal(app.chatPreferences.list()[sessionId].pinned, true);
    assert.equal(app.chatPreferences.list()[sessionId].generatedTitle, 'New generated name');
  } finally { await app.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('saved untitled chats get prompt titles while generated and renamed titles survive', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'handwork-chat-title-'));
  try {
    const folder = path.join(directory, 'untitled0001');
    await mkdir(folder);
    await writeFile(path.join(folder, 'session.json'), '{}');
    await writeFile(path.join(folder, 'events.jsonl'), JSON.stringify({ schema_version: 2, seq: 1, timestamp_ms: 1, event: { user: { text: 'Help me plan a trip to Ohio' } } }) + '\n');
    const app = new DesktopBackend({ settingsService: { home: directory }, chatSearch: new ChatSearchIndex(directory) });
    app.chatPreferences.update('renamed0001', { title: 'My saved name' });
    const sessions = [
      { sessionId: 'untitled0001', title: '', cwd: '/project', turns: 1 },
      { sessionId: 'generated001', title: 'Ohio travel plans', cwd: '', turns: 1 },
      { sessionId: 'renamed0001', title: '', cwd: '', turns: 1 },
      { sessionId: 'missing0001', title: '', cwd: '', turns: 1 },
    ];
    const calls = [];
    app.client = { closed: false, async request(method) { calls.push(method); return { sessions }; } };
    const result = await app.collectSessions();
    assert.deepEqual(result.sessions.map(session => session.title), ['Help me plan a trip to Ohio', 'Ohio travel plans', 'My saved name', 'New chat']);
    assert.deepEqual(app.listCachedSessions().sessions.map(session => session.title), result.sessions.map(session => session.title));
    assert.deepEqual(calls, ['session/list'], 'naming history must not load sessions or invoke a model');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
