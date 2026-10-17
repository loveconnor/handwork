import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { QueueStore } from '../../electron/queue-store.mjs';
import { validateArguments } from '../../electron/ipc.mjs';
import { mergeQueues, queueCounts, queueKey, readyQueues, restoreQueues } from '../../lib/message-queue.ts';

const image = { name: 'shot.png', mimeType: 'image/png', size: 4, data: Buffer.from('png!').toString('base64') };
const note = { name: 'notes.md', mimeType: 'text/markdown', size: 5, text: 'hello', uri: 'file:///tmp/notes.md' };
const command = item => !item.files.length && item.text.startsWith('/');
const ready = (state) => readyQueues({ paused: new Set(), running: new Set(), active: '', activeBlocked: false, isCommand: command, ...state }).map(({ session, item }) => [session, item.id]);

test('queued messages survive a restart in order, with attachments and pause state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-queues-'));
  try {
    const store = new QueueStore(path.join(root, 'queues'));
    store.save('chat-a', { paused: false, items: [{ id: 'one', text: 'First', files: [image, note], queuedAt: 1 }, { id: 'two', text: 'Second', files: [image] }] });
    store.save('chat-b', { paused: true, items: [{ id: 'three', text: '', files: [note] }] });

    const reopened = new QueueStore(path.join(root, 'queues')).list();
    const a = reopened.find(queue => queue.sessionId === 'chat-a');
    assert.deepEqual(a.items.map(item => item.text), ['First', 'Second']);
    assert.deepEqual(a.items[0].files.map(file => file.name), ['shot.png', 'notes.md']);
    assert.equal(a.items[0].files[0].data, image.data);
    assert.equal(a.items[0].files[1].text, 'hello');
    assert.equal(a.items[0].files[1].uri, note.uri);
    assert.equal(a.paused, false);
    assert.equal(reopened.find(queue => queue.sessionId === 'chat-b').paused, true);
    assert.equal((await readdir(path.join(root, 'queues', 'blobs'))).length, 2, 'the same attachment is stored once');

    // Sending the first message leaves the rest; an emptied queue is removed with its attachments.
    store.save('chat-a', { paused: false, items: a.items.slice(1) });
    assert.deepEqual(store.list().find(queue => queue.sessionId === 'chat-a').items.map(item => item.id), ['two']);
    store.save('chat-a', { paused: false, items: [] });
    store.remove(['chat-b']);
    assert.deepEqual(store.list(), []);
    assert.equal((await readdir(path.join(root, 'queues', 'blobs'))).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('restored queues come back paused so nothing sends before review', () => {
  const saved = [{ sessionId: 'a', paused: false, updatedAt: 2, items: [{ id: '1', text: 'go', files: [] }, { id: '2', text: 'then', files: [] }] }, { sessionId: 'b', paused: true, updatedAt: 1, items: [{ id: '3', text: 'later', files: [] }] }];
  const restored = restoreQueues(saved);
  assert.deepEqual([...restored.paused].sort(), ['a', 'b']);
  assert.equal(restored.count, 3);
  assert.deepEqual(ready({ queues: restored.queues, paused: restored.paused }), []);
  // The saved key is what is on disk, so the restored pause is written back on the next save.
  assert.notEqual(restored.keys.get('a'), queueKey(restored.queues.a, true));
  assert.equal(queueKey([], true), '', 'an empty queue saves as removed regardless of pause');
});

test('each queue sends in its own chat while another chat is open', () => {
  const queues = { a: [{ id: 'a1', text: 'next for a', files: [] }], b: [{ id: 'b1', text: 'next for b', files: [] }], c: [{ id: 'c1', text: '/model fast', files: [] }] };
  // The person reads chat b; chat a finished its reply in the background.
  assert.deepEqual(ready({ queues, active: 'b', running: new Set(['b']) }), [['a', 'a1']]);
  // A running or paused chat waits, and so does the open chat while it is busy loading.
  assert.deepEqual(ready({ queues, active: 'b', running: new Set(['a']), paused: new Set(['b']) }), []);
  assert.deepEqual(ready({ queues, active: 'b', activeBlocked: true }), [['a', 'a1']]);
  // Slash commands change the open chat, so a background chat's command waits until it is opened.
  assert.deepEqual(ready({ queues: { c: queues.c }, active: 'b' }), []);
  assert.deepEqual(ready({ queues: { c: queues.c }, active: 'c' }), [['c', 'c1']]);
  // A chat that is being opened does not send underneath its own history replay.
  assert.deepEqual(ready({ queues: { a: queues.a }, active: 'b', opening: 'a' }), []);
  assert.deepEqual([...queueCounts({ a: queues.a, empty: [] })], [['a', 1]]);
});

test('queue work across switching, cancelling, quitting, and reopening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-queue-flow-'));
  try {
    const directory = path.join(root, 'queues');
    let store = new QueueStore(directory);
    // Two follow-ups with attachments are queued in chat a while it replies.
    let queues = { a: [{ id: 'q1', text: 'Review the screenshot', files: [image] }, { id: 'q2', text: 'Then summarize', files: [note] }] };
    store.save('a', { paused: false, items: queues.a });
    // The person switches to chat b. Chat a finishes and sends its first follow-up there.
    const [first] = readyQueues({ queues, paused: new Set(), running: new Set(), active: 'b', activeBlocked: false, isCommand: command });
    assert.equal(first.session, 'a');
    queues = { a: queues.a.slice(1) };
    store.save('a', { paused: false, items: queues.a });
    // The person opens a and stops the reply, which pauses the rest of the queue.
    const paused = new Set(['a']);
    store.save('a', { paused: true, items: queues.a });
    assert.deepEqual(readyQueues({ queues, paused, running: new Set(), active: 'a', activeBlocked: false, isCommand: command }), []);

    // Quit and reopen.
    store = new QueueStore(directory);
    const restored = restoreQueues(store.list());
    assert.deepEqual(restored.queues.a.map(item => item.text), ['Then summarize']);
    assert.equal(restored.queues.a[0].files[0].text, 'hello');
    assert.ok(restored.paused.has('a'));
    // Resuming sends it in chat a.
    assert.deepEqual(readyQueues({ queues: restored.queues, paused: new Set(), running: new Set(), active: 'a', activeBlocked: false, isCommand: command }).map(entry => entry.item.id), ['q2']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('queues restored from a backup never replace a queue already open', () => {
  const current = { a: [{ id: 'mine', text: 'local', files: [] }] };
  const { queues, added } = mergeQueues(current, [{ sessionId: 'a', paused: true, updatedAt: 1, items: [{ id: 'old', text: 'backup', files: [] }] }, { sessionId: 'b', paused: true, updatedAt: 1, items: [{ id: 'b1', text: 'backup b', files: [] }] }]);
  assert.deepEqual(queues.a.map(item => item.id), ['mine']);
  assert.deepEqual(added, ['b']);
});

test('saving a queue validates its messages', () => {
  const valid = { paused: true, items: [{ id: 'f0a1-b2', text: 'hi', files: [note], queuedAt: 5 }] };
  assert.doesNotThrow(() => validateArguments('saveQueue', ['chat-1', valid]));
  assert.doesNotThrow(() => validateArguments('saveQueue', ['chat-1', { paused: false, items: [] }]));
  for (const queue of [
    { paused: 'yes', items: [] },
    { paused: false, items: [{ id: 'a', text: 'x', files: [] }, { id: 'a', text: 'y', files: [] }] },
    { paused: false, items: [{ id: '../x', text: 'x', files: [] }] },
    { paused: false, items: [{ id: 'a', text: 'x\0', files: [] }] },
    { paused: false, items: Array.from({ length: 51 }, (_, index) => ({ id: `m${index}`, text: 'x', files: [] })) },
    { paused: false, items: [], extra: true },
  ]) assert.throws(() => validateArguments('saveQueue', ['chat-1', queue]), /argument 2/);
  assert.throws(() => validateArguments('saveQueue', ['../chat', valid]), /argument 1/);
});
