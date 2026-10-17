import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { attentionItems, nextAttention } from '../../lib/attention.ts';
import { attachmentAllowance, planAttachments, stageAttachments } from '../../lib/attachment-staging.ts';
import { adjacentTab, numberedTab, rememberClosed, reopenCandidate } from '../../lib/tab-navigation.ts';
import { shortcutGroups } from '../../lib/shortcuts.ts';
import { DesktopBackend, readAttachments } from '../../electron/backend.mjs';
import { validateArguments } from '../../electron/ipc.mjs';

const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const MB = 1024 * 1024;
const binary = (name, size) => ({ name, mimeType: 'application/octet-stream', size, data: 'A'.repeat(Math.ceil(size / 3) * 4) });

test('chats that need the person come before working chats, each under its most urgent need', () => {
  const chats = [{ id: 'a', label: 'Approve deploy' }, { id: 'b', label: 'Interrupted' }, { id: 'c', label: 'Queued work' }, { id: 'd', label: 'Busy' }, { id: 'e', label: 'Broken' }];
  const items = attentionItems({
    chats, approvals: new Map([['a', 1]]), issues: { e: { kind: 'failed', message: 'Provider returned 500' } },
    recoverable: new Set(['b']), pausedQueues: new Map([['c', 2]]), running: new Set(['a', 'd']), queued: new Map([['d', 1]]),
  });
  assert.deepEqual(items.map(item => [item.id, item.kind]), [['a', 'approval'], ['e', 'failed'], ['b', 'interrupted'], ['c', 'queue'], ['d', 'running']]);
  assert.equal(items.find(item => item.id === 'a').detail, 'Waiting for your approval', 'a running chat waiting for approval is listed once, as needing approval');
  assert.equal(items.find(item => item.id === 'c').detail, 'Queue paused · 2 messages waiting');
  assert.equal(items.find(item => item.id === 'd').detail, 'Working · 1 queued');
  // The shortcut cycles through chats that need the person and skips working ones.
  assert.equal(nextAttention(items, 'a').id, 'e');
  assert.equal(nextAttention(items, 'c').id, 'a');
  assert.equal(nextAttention(items, 'd').id, 'a');
  assert.equal(nextAttention(items.filter(item => item.kind === 'running'), 'x'), undefined);
});

test('every file offered is either attached or listed with its own reason', () => {
  const current = [binary('one.bin', 1 * MB)];
  const plan = planAttachments(current, [
    { name: 'huge.mov', size: 12 * MB }, { name: 'one.bin', size: 1 * MB }, { name: 'ok.png', size: 2 * MB },
    { name: 'too-much.zip', size: 4 * MB }, { name: 'small.txt', size: 1000 },
  ]);
  assert.deepEqual(plan.accepted, [2, 4], 'files that fit are kept even when others fail');
  assert.deepEqual(plan.rejected.map(file => file.name), ['huge.mov', 'one.bin', 'too-much.zip']);
  assert.match(plan.rejected[0].reason, /12\.0 MB is over the 5 MB limit/);
  assert.equal(plan.rejected[1].reason, 'Already attached');
  assert.match(plan.rejected[2].reason, /Not enough room left in this message \(about .* left\)/);

  const many = Array.from({ length: 12 }, (_, index) => ({ name: `note-${index}.txt`, mimeType: 'text/plain', size: 10, text: 'x'.repeat(10) }));
  const staged = stageAttachments([], many);
  assert.equal(staged.files.length, 10);
  assert.deepEqual(staged.rejected.map(file => [file.name, file.reason]), [['note-10.txt', 'A message can carry 10 files'], ['note-11.txt', 'A message can carry 10 files']]);
  const allowance = attachmentAllowance(staged.files);
  assert.equal(allowance.remaining, 0);
  assert.ok(allowance.leftBytes > 5 * MB, 'text files cost only their bytes');
  assert.equal(attachmentAllowance([binary('a', 3 * MB)]).leftBytes, Math.floor((7 * MB - Math.ceil(3 * MB / 3) * 4) * 3 / 4));
});

test('picking files reads the ones that fit and reports the rest without failing the selection', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-pick-'));
  try {
    await writeFile(path.join(root, 'a.txt'), 'alpha');
    await writeFile(path.join(root, 'big.bin'), Buffer.alloc(5 * MB + 1));
    await writeFile(path.join(root, 'b.txt'), 'beta');
    await mkdir(path.join(root, 'folder'));
    const result = await readAttachments(['a.txt', 'big.bin', 'missing.txt', 'folder', 'b.txt'].map(name => path.join(root, name)), 1);
    assert.deepEqual(result.files.map(file => file.name), ['a.txt']);
    assert.deepEqual(result.rejected.map(file => [file.name, file.reason]), [
      ['big.bin', '5.0 MB is over the 5 MB limit per file'], ['missing.txt', 'Could not be read'],
      ['folder', 'Folders cannot be attached'], ['b.txt', 'A message can carry 10 files'],
    ]);
    assert.doesNotThrow(() => validateArguments('chooseFiles', []), 'older renderers still pick files');
    assert.doesNotThrow(() => validateArguments('chooseFiles', [4]));
    assert.throws(() => validateArguments('chooseFiles', [11]), /argument 1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('chat details list the instruction files the engine reads, broadest first, and none for standalone chats', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-details-'));
  try {
    const home = path.join(root, 'home');
    const project = path.join(root, 'work', 'app');
    await mkdir(path.join(home, '.handwork'), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(path.join(home, '.handwork', 'AGENTS.md'), 'global');
    await writeFile(path.join(root, 'work', 'AGENTS.md'), 'team');
    await writeFile(path.join(project, 'AGENTS.md'), 'project');
    const { realpath } = await import('node:fs/promises');
    await writeFile(path.join(home, '.handwork', 'settings.json'), JSON.stringify({ permission: { read: 'allow' }, workspaces: { [await realpath(project)]: { permission: { bash: 'ask' }, additional_directories: ['/extra'] } } }));
    const app = new DesktopBackend({ settingsService: { home, settings: {} } });
    app.workspace = project;
    const details = await app.chatDetails();
    assert.equal(details.standalone, false);
    assert.deepEqual(details.instructions.map(file => [file.scope, path.relative(root, file.path)]), [
      ['app', path.join('home', '.handwork', 'AGENTS.md')], ['ancestor', path.join('work', 'AGENTS.md')], ['project', path.join('work', 'app', 'AGENTS.md')],
    ]);
    assert.deepEqual(details.directories, ['/extra']);
    assert.deepEqual(details.permissions, { global: { read: 'allow' }, project: { bash: 'ask' } });
    app.workspace = '';
    const standalone = await app.chatDetails();
    assert.equal(standalone.standalone, true);
    assert.deepEqual(standalone.instructions, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tabs move in order, jump by number, and reopen the last closed chat', () => {
  const tabs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(adjacentTab(tabs, 'c', 1).id, 'a');
  assert.equal(adjacentTab(tabs, 'a', -1).id, 'c');
  assert.equal(adjacentTab(tabs, 'unknown', 1).id, 'a');
  assert.equal(adjacentTab([], 'a', 1), undefined);
  assert.equal(numberedTab(tabs, 2).id, 'b');
  assert.equal(numberedTab(tabs, 9).id, 'c', '9 always means the last tab');
  assert.equal(numberedTab(tabs, 5), undefined);
  let closed = rememberClosed([], { id: 'a' });
  closed = rememberClosed(closed, { id: 'b' });
  closed = rememberClosed(closed, { id: 'a' });
  assert.deepEqual(closed.map(tab => tab.id), ['b', 'a']);
  // A deleted chat or one that is open again is skipped.
  const { tab, rest } = reopenCandidate([...closed, { id: 'gone' }], ['a'], id => id !== 'gone');
  assert.equal(tab.id, 'b');
  assert.deepEqual(rest, []);
});

test('the shortcut reference, the menu, and the key handlers agree on tab and window keys', () => {
  const groups = shortcutGroups({ desktop: true, mac: true });
  const find = label => groups.flatMap(group => group.items).find(item => item.label === label);
  assert.deepEqual(find('Close tab').keys, ['Mod+W']);
  assert.deepEqual(find('Close window').keys, ['Mod+Shift+W'], 'closing a tab and the window use different keys');
  assert.deepEqual(find('Next tab').keys, ['Control+Tab', 'Mod+Shift+]']);
  assert.deepEqual(find('Reopen closed tab').keys, ['Mod+Shift+T']);
  assert.deepEqual(find('Next chat that needs you').keys, ['Mod+Shift+A']);
  assert.ok(!shortcutGroups({ desktop: false }).some(group => group.title === 'Tabs'), 'browsers keep their own tab keys');
  const main = source('electron/main.mjs');
  for (const [label, accelerator] of [['Close Tab', 'CmdOrCtrl\\+W'], ['Close Window', 'CmdOrCtrl\\+Shift\\+W'], ['Reopen Closed Tab', 'CmdOrCtrl\\+Shift\\+T'], ['Next Tab', 'Ctrl\\+Tab'], ['Previous Tab', 'Ctrl\\+Shift\\+Tab'], ['Next Chat Needing Attention', 'CmdOrCtrl\\+Shift\\+A'], ['Chat Details', 'CmdOrCtrl\\+I']]) {
    assert.match(main, new RegExp(`label: '${label}', accelerator: '${accelerator}'`), label);
  }
  assert.doesNotMatch(main, /role: 'windowMenu'/, 'the default window menu would bind ⌘W to closing the window');
  const harness = source('components/site/HandworkHarness.tsx');
  for (const pattern of [/event\.code === 'BracketRight'/, /event\.code === 'BracketLeft'/, /Digit\(\[1-9\]\)/, /key === 'w'\) run\('close'\)/, /key === 't'\) run\('reopen'\)/, /key === 'a'\) run\('attention'\)/, /key === 'i'\) run\('details'\)/]) assert.match(harness, pattern);
});

test('context usage is saved with the chat and shown again after it is reopened', async () => {
  const { ChatPreferences } = await import('../../electron/chat-preferences.mjs');
  const { withSavedUsage, emptyConversation } = await import('../../lib/desktop-state.ts');
  const chatPreferences = new ChatPreferences();
  chatPreferences.update('chat-1', { title: 'Keep me' });
  const app = new DesktopBackend({ chatPreferences, settingsService: { home: '/tmp' } });
  const events = [];
  app.on('event', event => events.push(event));
  app.rememberUsage('chat-1', { sessionUpdate: 'usage_update', used: 18400, size: 272000 });
  app.rememberUsage('chat-1', { sessionUpdate: 'usage_update', used: 18400, size: 272000 });
  app.rememberUsage('chat-1', { sessionUpdate: 'usage_update', used: 'lots' });
  const saved = chatPreferences.list()['chat-1'];
  assert.equal(saved.title, 'Keep me', 'other preferences are kept');
  assert.deepEqual({ used: saved.usage.used, size: saved.usage.size }, { used: 18400, size: 272000 });
  assert.equal(events.filter(event => event.method === 'desktop/chat-usage').length, 1, 'an unchanged figure is not saved twice');
  // A reopened chat has no live figure yet, so the saved one is shown; a live report wins.
  const reopened = withSavedUsage(emptyConversation(), saved.usage);
  assert.deepEqual([reopened.used, reopened.capacity], [18400, 272000]);
  const live = withSavedUsage({ ...emptyConversation(), used: 20000, capacity: 272000 }, saved.usage);
  assert.equal(live.used, 20000);
});
