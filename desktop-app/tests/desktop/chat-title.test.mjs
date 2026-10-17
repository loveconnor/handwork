import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chatTitle, isPlaceholderTitle } from '../../electron/chat-title.mjs';
import { ChatSearchIndex } from '../../electron/chat-search.mjs';
import { DesktopBackend } from '../../electron/backend.mjs';

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
