import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chatVersionIds, collapseChatVersions, versionFamily, versionPosition, versionTurns } from '../../lib/chat-versions.ts';
import { ChatPreferences } from '../../electron/chat-preferences.mjs';
import { DesktopBackend } from '../../electron/backend.mjs';
import { validateArguments } from '../../electron/ipc.mjs';

const branch = (from, turn, at) => ({ branch: { from, turn, at } });

test('edits and retries stay in one chat row across different turns and reopening', () => {
  const preferences = { edit: branch('original', 0, 10), retry: branch('edit', 3, 20), alternative: branch('original', 1, 30) };
  // Input is sorted by activity, as it is in the harness.
  const chats = ['alternative', 'unrelated', 'retry', 'edit', 'original'].map(id => ({ id, workspace: '/project' }));
  const ids = rows => rows.map(chat => chat.id);
  assert.deepEqual(ids(collapseChatVersions(chats, preferences, 'retry')), ['retry', 'unrelated']);
  assert.deepEqual(ids(collapseChatVersions(chats, preferences, 'original')), ['original', 'unrelated'], 'opening an earlier version still selects the single row');
  assert.deepEqual(ids(collapseChatVersions(chats, preferences, 'unrelated')), ['alternative', 'unrelated'], 'a closed chat reopens its most recently active version');
  assert.deepEqual([...chatVersionIds(preferences, 'edit', new Set(chats.map(chat => chat.id)))].sort(), ['alternative', 'edit', 'original', 'retry']);
  assert.deepEqual(versionFamily(preferences, 'edit', 0), ['original', 'edit'], 'hidden sessions remain available to the message version arrows');
  assert.equal(chats.length, 5, 'collapsing rows preserves the stored versions');
});

test('chat rows tolerate missing originals, cycles and links across workspaces', () => {
  const preferences = { edit: branch('missing', 0, 10), retry: branch('edit', 1, 20), a: branch('b', 0, 30), b: branch('a', 0, 40) };
  const chats = [{ id: 'retry' }, { id: 'edit' }, { id: 'a', workspace: '/one' }, { id: 'b', workspace: '/two' }];
  assert.deepEqual(collapseChatVersions(chats, preferences, '').map(chat => chat.id), ['retry', 'a', 'b']);
  assert.deepEqual([...chatVersionIds(preferences, 'a', new Set(['a', 'b']))].sort(), ['a', 'b']);
  assert.deepEqual(collapseChatVersions([], preferences, ''), []);
});

test('retries of one turn form a single family in the order they were made', () => {
  // v1 → v2 (retry turn 2) → v3 (retry turn 2 again, from v2); v4 retries v1 later.
  const preferences = { v1: { title: 'Plan' }, v2: branch('v1', 2, 10), v3: branch('v2', 2, 20), v4: branch('v1', 2, 30) };
  for (const id of ['v1', 'v2', 'v3', 'v4']) assert.deepEqual(versionFamily(preferences, id, 2), ['v1', 'v2', 'v3', 'v4']);
  assert.deepEqual(versionPosition(preferences, 'v3', 2), { index: 2, total: 4, previous: 'v2', next: 'v4' });
  assert.deepEqual(versionPosition(preferences, 'v1', 2), { index: 0, total: 4, previous: undefined, next: 'v2' });
});

test('versions of different turns stay separate', () => {
  // v2 edits turn 0 of v1; v3 retries turn 3 of v2. Turn 3 of v1 never matched v2's.
  const preferences = { v2: branch('v1', 0, 10), v3: branch('v2', 3, 20) };
  assert.deepEqual(versionFamily(preferences, 'v2', 0), ['v1', 'v2']);
  assert.deepEqual(versionFamily(preferences, 'v2', 3), ['v2', 'v3']);
  assert.deepEqual(versionFamily(preferences, 'v1', 3), ['v1']);
  assert.equal(versionPosition(preferences, 'v1', 3), undefined, 'a single version shows no switcher');
  assert.deepEqual(versionTurns(preferences, 'v2'), [0, 3]);
  assert.deepEqual(versionTurns(preferences, 'v1'), [0]);
  assert.deepEqual(versionTurns(preferences, 'v3'), [3]);
});

test('unavailable chats are skipped and damaged links cannot loop', () => {
  const preferences = { v2: branch('v1', 1, 10), v3: branch('v2', 1, 20) };
  assert.deepEqual(versionFamily(preferences, 'v3', 1, new Set(['v2', 'v3'])), ['v2', 'v3'], 'a chat in a removed project is not offered');
  assert.deepEqual(versionTurns(preferences, 'v2', new Set(['v2'])), [], 'links to missing chats are ignored');
  const looped = { a: branch('b', 1, 1), b: branch('a', 1, 2) };
  assert.equal(versionFamily(looped, 'a', 1).length, 2);
  assert.ok(!versionFamily({ __proto__: branch('x', 1, 1) }, 'missing', 1).includes('x'), 'inherited properties are not links');
});

test('deleting a version keeps the remaining versions linked where they still match', () => {
  const preferences = new ChatPreferences();
  preferences.write({ v1: {}, v2: branch('v1', 2, 10), v3: branch('v2', 2, 20), v4: branch('v2', 1, 30), v5: branch('v2', 4, 40), v6: branch('v2', 4, 50) });
  preferences.remove('v2');
  const saved = preferences.list();
  assert.deepEqual(saved.v3.branch, { from: 'v1', turn: 2, at: 20 }, 'a retry of the same turn moves to the original');
  assert.deepEqual(saved.v4.branch, { from: 'v1', turn: 1, at: 30 }, 'earlier turns still match the original');
  assert.equal(saved.v5.branch, undefined, 'the oldest later-turn version becomes an original');
  assert.deepEqual(saved.v6.branch, { from: 'v5', turn: 4, at: 50 });
  assert.deepEqual(versionFamily(saved, 'v1', 2), ['v1', 'v3']);
  preferences.remove('v1');
  assert.equal(preferences.list().v3.branch, undefined, 'deleting the original promotes the oldest remaining version');
});

test('rewinding records the original and keeps a custom name; IPC cannot forge links', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'handwork-versions-'));
  try {
    const preferences = new ChatPreferences(path.join(directory, 'preferences.json'));
    preferences.update('original', { title: 'Release plan', pinned: true, archived: false });
    const backend = new DesktopBackend({ chatPreferences: preferences, settingsService: { home: directory } });
    const requests = [];
    const engine = { session: { sessionId: 'original' }, client: { async request(method, params) { requests.push([method, params]); return { sessionId: 'retry', configOptions: [] }; } } };
    backend.engines.add(engine);
    const result = await backend.rewindSession(2, 'Ship it?', 'original');
    assert.deepEqual(requests, [['session/rewind', { sessionId: 'original', turnIndex: 2, expectedText: 'Ship it?' }]]);
    assert.equal(result.sessionId, 'retry');
    assert.equal(result.branch.from, 'original');
    assert.equal(result.branch.turn, 2);
    const saved = new ChatPreferences(path.join(directory, 'preferences.json')).list();
    assert.deepEqual(saved.retry, { branch: result.branch, title: 'Release plan', pinned: true, archived: false });
    assert.equal(saved.original.pinned, true, 'the original keeps its own settings');
    assert.equal(engine.session.sessionId, 'retry');
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assert.throws(() => validateArguments('updateChat', ['chat', { branch: { from: 'other', turn: 0, at: 1 } }]), /argument 2/);
});
