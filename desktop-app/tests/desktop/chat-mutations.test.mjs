import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { OptimisticChatUpdates } from '../../lib/optimistic-chat-updates.ts';
import { DesktopBackend } from '../../electron/backend.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('rename, pin and archive publish before saving and refreshes retain pending edits', async () => {
  const updates = new OptimisticChatUpdates();
  const pending = deferred();
  let visible;
  const saving = updates.update('a', { pinned: false }, { title: 'New name', pinned: true, archived: true },
    () => pending.promise, value => { visible = value; });
  assert.deepEqual(visible, { title: 'New name', pinned: true, archived: true });
  assert.deepEqual(updates.merge({ a: { title: 'Old name' } }).a, visible);
  pending.resolve({ ...visible, usage: { used: 100 } });
  await saving;
  assert.equal(visible.usage.used, 100);
});

test('rapid edits save in order without earlier responses undoing newer choices', async () => {
  const updates = new OptimisticChatUpdates();
  const first = deferred(), second = deferred();
  let visible;
  const publish = value => { visible = value; };
  const a = updates.update('a', { title: 'Old' }, { title: 'First' }, () => first.promise, publish);
  const b = updates.update('a', visible, { title: 'Second', pinned: true }, () => second.promise, publish);
  assert.equal(visible.title, 'Second');
  first.resolve({ title: 'First' });
  await a;
  assert.deepEqual(visible, { title: 'Second', pinned: true });
  second.resolve({ title: 'Second', pinned: true });
  await b;
  assert.deepEqual(visible, { title: 'Second', pinned: true });
});

test('failed edits roll back without erasing later edits, even when both fail', async () => {
  const updates = new OptimisticChatUpdates();
  const first = deferred(), second = deferred();
  let visible;
  const a = updates.update('a', { title: 'Original', pinned: false }, { title: 'First' }, () => first.promise, value => { visible = value; });
  const b = updates.update('a', visible, { pinned: true }, () => second.promise, value => { visible = value; });
  const failedA = assert.rejects(a, /offline/);
  const failedB = assert.rejects(b, /offline/);
  first.reject(new Error('offline'));
  await failedA;
  assert.deepEqual(visible, { title: 'Original', pinned: true });
  second.reject(new Error('offline'));
  await failedB;
  assert.deepEqual(visible, { title: 'Original', pinned: false });
});

const source = readFileSync(new URL('../../components/site/HandworkHarness.tsx', import.meta.url), 'utf8');
function harnessFunction(name, env) {
  const ast = ts.createSourceFile('harness.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(declaration, name);
  const compiled = ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('env', `with(env) { ${compiled}; return ${name}; }`)(env);
}

function fixture() {
  const pending = deferred();
  const chats = ['a', 'b', 'c'].map(id => ({ id, label: id }));
  const env = {
    api: { deleteSession: () => pending.promise }, chatIds: () => new Set(['a']), deleteBlocked: () => false,
    sessions: chats, tabs: chats, sessionId: 'a', workspace: '/project', chatPreferences: {},
    pendingChatRef: { current: undefined }, activeSession: { current: 'a' },
    removedChats: { current: new Set() }, deletingChats: { current: new Set() },
    chatUpdates: { current: new OptimisticChatUpdates() },
    chatCache: { current: new Map() }, drafts: { current: new Map() }, permissionCache: { current: new Map() },
    setError() {}, setNotice() {}, editQueue() {}, clearIssue() {}, refreshSessions: async () => {},
    setTabs(update) { env.tabs = update(env.tabs); }, setSessions(update) { env.sessions = update(env.sessions); },
    openChat(chat) { env.pendingChatRef.current = chat; }, openNewTab() { env.pendingChatRef.current = { id: '' }; },
    lock: { current: false }, setWorking() { assert.fail('Deletion must not disable the app'); },
  };
  return { env, pending, remove: harnessFunction('deleteSession', env) };
}

test('deleting the selected chat immediately removes it and selects a neighbor without locking the app', async () => {
  const { env, pending, remove } = fixture();
  const saving = remove('a');
  assert.deepEqual(env.tabs.map(chat => chat.id), ['b', 'c']);
  assert.deepEqual(env.sessions.map(chat => chat.id), ['b', 'c']);
  assert.equal(env.pendingChatRef.current.id, 'b');
  assert.equal(env.lock.current, false);
  // The person navigates elsewhere while removal finishes.
  env.pendingChatRef.current = { id: 'c' };
  pending.resolve({});
  await saving;
  assert.equal(env.pendingChatRef.current.id, 'c');
  assert.equal(env.removedChats.current.has('a'), true);
});

test('a failed deletion restores its chat without replacing newer tabs or selection', async () => {
  const { env, pending, remove } = fixture();
  const saving = remove('a');
  env.tabs.push({ id: 'new', label: 'New chat' });
  env.pendingChatRef.current = { id: 'new' };
  const failed = assert.rejects(saving, /offline/);
  pending.reject(new Error('offline'));
  await failed;
  assert.deepEqual(env.tabs.map(chat => chat.id), ['b', 'c', 'new', 'a']);
  assert.equal(env.pendingChatRef.current.id, 'new');
  assert.equal(env.removedChats.current.has('a'), false);
  assert.equal(env.deletingChats.current.size, 0);
});

test('stale sidebar refreshes cannot resurrect a deletion or replace newer preferences', async () => {
  const updates = new OptimisticChatUpdates();
  const pending = deferred();
  const env = {
    activeWorkspace: { current: '' }, chatUpdates: { current: updates }, removedChats: { current: new Set(['deleted']) },
    record: value => value ?? {}, text: value => typeof value === 'string' ? value : '', chatTitle: value => value,
    setChatPreferences(value) { env.preferences = value; }, setSessions(value) { env.sessions = value; },
  };
  const refresh = harnessFunction('refreshSessions', env);
  const refreshing = refresh({ listSessions: () => pending.promise });
  updates.invalidate();
  pending.resolve({ sessions: [{ sessionId: 'deleted', turns: 1 }], preferences: { a: { title: 'Old' } } });
  await refreshing;
  assert.equal(env.preferences, undefined);
  await refresh({ listSessions: async () => ({ sessions: [{ sessionId: 'deleted', turns: 1 }, { sessionId: 'kept', turns: 1 }] }) });
  assert.deepEqual(env.sessions.map(chat => chat.id), ['kept']);
});

test('engine deletion does not hold the global navigation lock or block another chat', async () => {
  const backend = new DesktopBackend({ settingsService: { home: '/tmp' } });
  const pending = deferred();
  const removing = { session: { sessionId: 'a' }, workspace: '', running: false, client: { closed: false, request: () => pending.promise } };
  const neighbor = { session: { sessionId: 'b' }, workspace: '', running: false, client: { closed: false } };
  backend.engines.add(removing); backend.engines.add(neighbor);
  backend.activate(removing);
  const deletion = backend.deleteSession('a');
  assert.equal(backend.deleteSession('a'), deletion, 'duplicate removal shares its request');
  let timer;
  try {
    const selected = await Promise.race([backend.loadSession('b'), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Navigation waited for deletion')), 1000); })]);
    assert.equal(selected.sessionId, 'b');
    assert.equal(await backend.sessionExclusive(neighbor, async () => 'ready to send'), 'ready to send');
    await assert.rejects(backend.loadSession('a'), /being deleted/);
  } finally { clearTimeout(timer); pending.resolve({}); await deletion; }
  assert.equal(backend.session.sessionId, 'b', 'late deletion must not clear the new foreground chat');
});

test('partial version deletion restores only the versions that failed', async () => {
  const { env, remove } = fixture();
  env.chatIds = () => new Set(['a', 'b']);
  env.api.deleteSession = async id => { if (id === 'b') throw new Error('cannot remove b'); };
  await assert.rejects(remove('a'), /cannot remove b/);
  assert.deepEqual(env.sessions.map(chat => chat.id), ['c', 'b']);
  assert.equal(env.removedChats.current.has('a'), true);
  assert.equal(env.removedChats.current.has('b'), false);
});

test('renaming closes the dialog before persistence finishes', async () => {
  const pending = deferred();
  const env = {
    api: {}, chatAction: { kind: 'rename', chat: { id: 'a' } }, savingChat: false, chatName: 'New name',
    setSavingChat(value) { env.savingChat = value; }, setChatActionError() {},
    setChatAction(value) { env.chatAction = value; },
    updateChatVersions(id, changes) { env.changes = changes; return pending.promise; },
    setError(value) { env.error = value; },
  };
  await harnessFunction('saveChatAction', env)();
  assert.equal(env.chatAction, undefined);
  assert.equal(env.savingChat, false);
  assert.deepEqual(env.changes, { title: 'New name' });
  pending.reject(new Error('offline'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.error, 'offline');
});

test('removing a project closes its dialog immediately and restores it if saving fails', async () => {
  const pending = deferred();
  const env = {
    api: { removeProject: () => pending.promise }, projectToDelete: '/project', projects: ['/project', '/other'],
    setProjects(update) { env.projects = update(env.projects); },
    setProjectToDelete(value) { env.projectToDelete = value; }, setError(value) { env.error = value; },
  };
  const saving = harnessFunction('deleteProject', env)();
  assert.equal(env.projectToDelete, undefined);
  assert.deepEqual(env.projects, ['/other']);
  env.projects.push('/new');
  pending.reject(new Error('offline'));
  await saving;
  assert.deepEqual(env.projects, ['/other', '/new', '/project']);
  assert.equal(env.error, 'offline');
});

test('closed-chat deletion leaves the foreground engine free and disposes its temporary client', async () => {
  const backend = new DesktopBackend({ settingsService: { home: '/tmp' } });
  const pending = deferred();
  const foreground = { session: { sessionId: 'active' }, workspace: '', running: false, client: { closed: false } };
  backend.engines.add(foreground); backend.activate(foreground);
  let disposed = false;
  const temporary = { running: false, client: { request: () => pending.promise, dispose() { disposed = true; } } };
  backend.openEngine = async () => { backend.engines.add(temporary); return temporary; };
  const saving = backend.deleteSession('closed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await backend.sessionExclusive(foreground, async () => 'sending'), 'sending');
  const failed = assert.rejects(saving, /offline/);
  pending.reject(new Error('offline'));
  await failed;
  assert.equal(disposed, true);
  assert.equal(backend.engines.has(temporary), false);
  assert.equal(backend.deletingSessions.size, 0);
  assert.equal(backend.session.sessionId, 'active');
});

test('deleting a chat that is already loading waits in the background instead of failing', async () => {
  const backend = new DesktopBackend({ settingsService: { home: '/tmp' } });
  const load = deferred();
  let removals = 0;
  const engine = { loadingSessionId: 'a', running: false, client: { request: async () => { removals++; return {}; } } };
  backend.engines.add(engine);
  backend.operationTail = load.promise;
  const saving = backend.deleteSession('a');
  assert.equal(removals, 0);
  assert.equal(backend.running, false);
  engine.session = { sessionId: 'a' };
  delete engine.loadingSessionId;
  load.resolve();
  await saving;
  assert.equal(removals, 1);
});
