import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, appendFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatSearchIndex, searchTerms } from '../../electron/chat-search.mjs';
import { SavedPrompts, validPromptInput } from '../../electron/saved-prompts.mjs';
import { validateArguments } from '../../electron/ipc.mjs';
import { validSettingsPatch } from '../../electron/desktop-settings.mjs';

let sequence = 0;
const line = event => JSON.stringify({ schema_version: 2, seq: ++sequence, timestamp_ms: 1, event }) + '\n';

async function session(root, id, { title = '', child = false, events }) {
  const folder = path.join(root, id);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'session.json'), JSON.stringify({ id, title, updated_at_ms: 1000 + sequence, subagent_child: child }));
  await writeFile(path.join(folder, 'events.jsonl'), events.map(line).join(''));
  return folder;
}

test('message search finds words and phrases in chat text, not tool output or subagents', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-search-'));
  try {
    await session(root, 'billing0001', { title: 'Untitled', events: [
      { user: { text: 'Why did the Stripe invoice fail?', images: [] } },
      { assistant: { text: 'The billing webhook ' } },
      { assistant: { text: 'rejected the retry.' } },
      { tool_result: { preview: 'billing secret token in tool output' } },
    ] });
    await session(root, 'toolonly001', { title: 'Logs', events: [{ user: { text: 'show logs' } }, { tool_result: { preview: 'zebra billing' } }] });
    await session(root, 'subagent001', { child: true, events: [{ user: { text: 'billing internals' } }] });
    const index = new ChatSearchIndex(root);

    const words = await index.search('BILLING retry');
    assert.deepEqual(words.terms, ['billing', 'retry']);
    assert.deepEqual(words.results.map(result => result.sessionId), ['billing0001']);
    assert.equal(words.results[0].role, 'assistant');
    // Streamed assistant chunks join into one message.
    assert.match(words.results[0].snippet, /billing webhook rejected the retry/);

    assert.equal((await index.search('"webhook rejected"')).results.length, 1);
    assert.equal((await index.search('"rejected webhook"')).results.length, 0);
    assert.equal((await index.search('voic')).results.length, 1, 'partial words match');
    assert.equal((await index.search('zebra')).results.length, 0, 'tool output stays out of the index');
    assert.equal((await index.search('internals')).results.length, 0, 'subagent sessions stay hidden');

    // New messages are picked up when the log changes.
    const events = path.join(root, 'toolonly001', 'events.jsonl');
    await appendFile(events, line({ assistant: { text: 'The zebra crossing is fixed.' } }));
    await utimes(events, new Date(), new Date(Date.now() + 5000));
    assert.deepEqual((await index.search('zebra')).results.map(result => result.sessionId), ['toolonly001']);

    await rm(path.join(root, 'billing0001'), { recursive: true });
    assert.equal((await index.search('billing')).results.length, 0, 'deleted chats leave the index');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('search terms keep quoted phrases and ignore duplicates', () => {
  assert.deepEqual(searchTerms('  "Exact Phrase" word word '), ['exact phrase', 'word']);
  assert.deepEqual(searchTerms('   '), []);
});

test('saved prompts persist edits and reject unknown or invalid prompts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-prompts-'));
  try {
    const store = new SavedPrompts(path.join(root, 'saved-prompts.json'));
    assert.deepEqual(store.list(), []);
    const saved = store.save({ title: '  Review PR ', folder: 'Code', text: 'Review {{branch}} for bugs.' });
    assert.equal(saved.title, 'Review PR');
    const edited = store.save({ id: saved.id, title: 'Review pull request', text: 'Review {{branch}}.' });
    assert.equal(edited.createdAt, saved.createdAt);
    assert.equal(new SavedPrompts(store.file).list().length, 1);
    assert.equal(new SavedPrompts(store.file).list()[0].title, 'Review pull request');
    assert.throws(() => store.save({ id: '00000000-0000-0000-0000-000000000000', title: 'Gone', text: 'x' }), /deleted/);
    store.remove(saved.id);
    assert.deepEqual(store.list(), []);
    assert.throws(() => store.remove(saved.id), /already deleted/);

    assert.equal(validPromptInput({ title: 'Ok', text: 'Body' }), true);
    assert.equal(validPromptInput({ title: '', text: 'Body' }), false);
    assert.equal(validPromptInput({ title: 'Line\nbreak', text: 'Body' }), false);
    assert.equal(validPromptInput({ title: 'Ok', text: 'Body', extra: true }), false);
    assert.equal(validPromptInput({ id: '../escape', title: 'Ok', text: 'Body' }), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('IPC and settings accept only the new feature inputs they expect', () => {
  validateArguments('searchChats', ['invoice retry']);
  validateArguments('captureScreen', []);
  validateArguments('savePrompt', [{ title: 'Daily summary', text: 'Summarize today.' }]);
  assert.throws(() => validateArguments('searchChats', ['']), /Invalid desktop API/);
  assert.throws(() => validateArguments('searchChats', ['x'.repeat(201)]), /Invalid desktop API/);
  assert.throws(() => validateArguments('deletePrompt', ['../../settings']), /Invalid desktop API/);
  assert.throws(() => validateArguments('captureScreen', ['/tmp/file.png']), /Invalid desktop API/);
  assert.equal(validSettingsPatch('app', { quickEntryShortcut: 'Alt+Space' }), true);
  assert.equal(validSettingsPatch('app', { quickEntryShortcut: 'off' }), true);
  assert.equal(validSettingsPatch('app', { quickEntryShortcut: 'CommandOrControl+Q' }), false);
  assert.equal(validSettingsPatch('project', { quickEntryShortcut: 'off' }), false);
});
