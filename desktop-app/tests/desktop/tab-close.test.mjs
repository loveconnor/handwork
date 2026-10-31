import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../../components/site/HandworkHarness.tsx', import.meta.url), 'utf8');
function functionSource(name) {
  const ast = ts.createSourceFile('harness.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, name);
  return found;
}
function controls(env) {
  const compiled = ts.transpileModule(['selectChatDraft', 'openNewTab', 'closeTab', 'sessionAction'].map(functionSource).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function('env', `with (env) { ${compiled}; return { selectChatDraft, openNewTab, closeTab, sessionAction }; }`)(env);
}
function setup() {
  const noop = () => {};
  const env = {
    api: {}, picking: false, tabs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], sessionId: 'a',
    pendingChatRef: { current: undefined }, closedTabs: { current: [] }, chatPreferences: {},
    rememberClosed: (tabs, tab) => [...tabs, tab],
    setTabs(value) { env.nextTabs = typeof value === 'function' ? value(env.tabs) : value; },
    setPendingChat: noop, setError: noop, setNotice: noop,
    openChat(chat) { env.pendingChatRef.current = chat; },
    configPending: { current: false }, lock: { current: false }, dictation: { cancel: noop },
    drafts: { current: new Map() }, draft: '', attachments: [], activeSession: { current: 'a' },
    conversation: { entries: [] }, permissions: [], chatCache: { current: new Map() },
    permissionCache: { current: new Map() }, activeWorkspace: { current: '' },
    setWorkspace: noop, setWorking: noop, setSessionId: noop, setConversation: noop,
    emptyConversation: () => ({ entries: [] }), sessions: [], setPermissions: noop,
    setDraft(value) { env.draft = value; }, setAttachments(value) { env.attachments = value; }, setRejectedFiles: noop, setPicking: noop,
    running: { current: new Set() },
    historyReplay: { current: undefined }, acceptSession() { throw new Error('Stale result accepted'); },
  };
  const actions = controls(env);
  return { env, ...actions, closeTab(id) {
    actions.closeTab(id);
    // React applies the state update after the event handler returns.
    if (env.nextTabs) { env.tabs = env.nextTabs; delete env.nextTabs; }
  } };
}

test('closing tabs stays immediate while the neighboring tab is still loading', () => {
  const { env, closeTab } = setup();
  closeTab('a');
  assert.deepEqual(env.tabs.map(tab => tab.id), ['b', 'c']);
  assert.equal(env.pendingChatRef.current.id, 'b');
  // sessionId still points to a until the engine finishes loading b.
  closeTab('b');
  assert.deepEqual(env.tabs.map(tab => tab.id), ['c']);
  assert.equal(env.pendingChatRef.current.id, 'c');
  closeTab('c');
  assert.deepEqual(env.tabs, []);
  assert.equal(env.pendingChatRef.current.id, '', 'the last close queues a fresh chat');
});

test('closing a background tab does not change the selected destination', () => {
  const { env, closeTab } = setup();
  env.pendingChatRef.current = { id: 'b' };
  closeTab('c');
  assert.equal(env.pendingChatRef.current.id, 'b');
  assert.deepEqual(env.tabs.map(tab => tab.id), ['a', 'b']);
});

for (const fails of [false, true]) {
  test(`a superseded load cannot reopen a closed tab or report its ${fails ? 'error' : 'result'}`, async () => {
    const { env, sessionAction, closeTab } = setup();
    let complete;
    env.api.loadSession = () => new Promise((resolve, reject) => { complete = fails ? reject : resolve; });
    const requested = { id: 'b' };
    env.pendingChatRef.current = requested;
    const loading = sessionAction('load', 'b', requested);
    assert.equal(env.lock.current, true);
    closeTab('b');
    assert.equal(env.pendingChatRef.current.id, 'c');
    env.setError = () => assert.fail('A stale error must not replace the selected chat');
    complete(fails ? new Error('Old load failed') : { sessionId: 'b' });
    await loading;
    assert.equal(env.lock.current, false);
    assert.deepEqual(env.tabs.map(tab => tab.id), ['a', 'c']);
    assert.equal(env.pendingChatRef.current.id, 'c');
  });
}

test('new tabs can be requested while a navigation holds the engine lock', () => {
  const { env, openNewTab } = setup();
  env.lock.current = true;
  openNewTab('/project');
  assert.deepEqual(env.pendingChatRef.current, { id: '', label: 'New chat', workspace: '/project' });
  assert.match(source, /closeDisabled=\{picking \|\| !api\} newDisabled=\{picking \|\| !api\}/);
});

test('drafts follow the selected tab before its engine is ready', () => {
  const { env, selectChatDraft } = setup();
  env.draft = 'Draft in a';
  env.attachments = [{ name: 'a.png' }];
  env.drafts.current.set('b', { text: 'Draft in b', files: [] });
  selectChatDraft('b');
  env.pendingChatRef.current = { id: 'b' };
  assert.equal(env.draft, 'Draft in b');
  env.draft = 'Typed while b loads';
  selectChatDraft('c');
  env.pendingChatRef.current = { id: 'c' };
  assert.equal(env.draft, '');
  selectChatDraft('b');
  assert.equal(env.draft, 'Typed while b loads');
  assert.deepEqual(env.drafts.current.get('a'), { text: 'Draft in a', files: [{ name: 'a.png' }] });
});

test('a delayed load leaves the visible draft editable and preserves new text', async () => {
  const { env, sessionAction } = setup();
  let complete;
  env.api.loadSession = () => new Promise(resolve => { complete = resolve; });
  const requested = { id: 'b' };
  env.pendingChatRef.current = requested;
  env.draft = 'Started before the load';
  const loading = sessionAction('load', 'b', requested);
  assert.equal(env.draft, 'Started before the load');
  env.draft = 'Typed during the load';
  env.pendingChatRef.current = { id: 'c' };
  complete({ sessionId: 'b' });
  await loading;
  assert.equal(env.draft, 'Typed during the load');
});

test('finishing the selected load keeps text typed before and during loading', async () => {
  const { env, sessionAction } = setup();
  let complete;
  env.api.loadSession = () => new Promise(resolve => { complete = resolve; });
  const requested = { id: 'b' };
  env.pendingChatRef.current = requested;
  env.initialHistoryRefresh = { current: false };
  env.providersReady = true;
  env.acceptSession = result => { env.sessionId = result.sessionId; };
  env.setError = error => { if (error) assert.fail(error); };
  env.draft = 'Started before the load';
  const loading = sessionAction('load', 'b', requested);
  assert.equal(env.draft, 'Started before the load');
  env.draft = 'Typed during the load';
  complete({ sessionId: 'b', historyReplayed: true });
  await loading;
  assert.equal(env.sessionId, 'b');
  assert.equal(env.draft, 'Typed during the load');
  assert.equal(env.lock.current, false);
});
