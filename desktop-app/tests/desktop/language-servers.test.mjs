import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LanguageServers, MessageReader, frame, findExecutable } from '../../electron/language-servers.mjs';
import { validateArguments } from '../../electron/ipc.mjs';
import { applyTextEdits, editsByUri, fileUri, languageServerFor, projectPath, uriKey } from '../../lib/language-servers.ts';

const require = createRequire(import.meta.url);
const fake = fileURLToPath(new URL('./fixtures/fake-language-server.mjs', import.meta.url));
const project = () => realpathSync.native(mkdtempSync(path.join(tmpdir(), 'lsp-project-')));

/** Messages the editor would receive, with a way to wait for the next one that matches. */
function inbox() {
  const events = [], waiters = [];
  const emit = event => { events.push(event); for (const waiter of [...waiters]) if (waiter.match(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); } };
  const next = (match, ms = 15000) => new Promise((resolve, reject) => {
    const found = events.find(match);
    if (found) { events.splice(events.indexOf(found), 1); return resolve(found); }
    const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), ms);
    waiters.push({ match, resolve: event => { clearTimeout(timer); events.splice(events.indexOf(event), 1); resolve(event); } });
  });
  return { emit, next, events };
}
const message = event => JSON.parse(event.params.message);

test('messages are read whole across chunk boundaries, several to a chunk', () => {
  const seen = [];
  const reader = new MessageReader(text => seen.push(JSON.parse(text)));
  const bytes = Buffer.concat([frame('{"a":"é"}'), frame('{"b":2}')]);
  for (const chunk of [bytes.subarray(0, 5), bytes.subarray(5, 21), bytes.subarray(21)]) reader.push(chunk);
  assert.deepEqual(seen, [{ a: 'é' }, { b: 2 }]);
  assert.throws(() => new MessageReader(() => {}).push(Buffer.from('Content-Length: 99999999999\r\n\r\n')), /unreadable/);
});

test('the project root and server options are set here, and configuration requests are answered for the editor', async () => {
  const workspace = project();
  const { emit, next, events } = inbox();
  const servers = new LanguageServers({ emit, execPath: process.execPath, bundled: () => ({ cli: fake, tsserver: '/bundled/tsserver.js' }) });
  const { id, name } = servers.start(workspace, 'typescript');
  assert.equal(name, 'TypeScript');
  servers.send(id, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { rootUri: 'file:///somewhere/else', capabilities: { textDocument: {} } } }));
  const initialized = message(await next(event => event.method === 'desktop/lsp-message' && message(event).id === 1));
  const received = initialized.result.received;
  assert.equal(received.rootUri, pathToFileURL(workspace).href);
  assert.deepEqual(received.workspaceFolders, [{ uri: pathToFileURL(workspace).href, name: path.basename(workspace) }]);
  assert.deepEqual(received.initializationOptions, { tsserver: { path: '/bundled/tsserver.js', useSyntaxServer: 'never' } });
  assert.equal(received.capabilities.workspace.configuration, true);
  // The server's configuration request never reached the editor; the server got its answer here.
  const answered = message(await next(event => event.method === 'desktop/lsp-message' && message(event).method === 'test/answered'));
  assert.deepEqual(answered.params, [null, null]);
  assert.ok(!events.some(event => event.method === 'desktop/lsp-message' && message(event).method === 'workspace/configuration'));
  assert.throws(() => servers.send(id, '{"not":"rpc"}'), /JSON-RPC/);
  // A server that dies says why; one that is closed on purpose does not.
  servers.send(id, JSON.stringify({ jsonrpc: '2.0', method: 'test/crash' }));
  const exit = await next(event => event.method === 'desktop/lsp-exit');
  assert.equal(exit.params.id, id);
  assert.match(exit.params.message, /TypeScript language server stopped: something broke/);
  assert.throws(() => servers.send(id, JSON.stringify({ jsonrpc: '2.0', method: 'x' })), /no longer running/);
  const second = servers.start(workspace, 'typescript');
  servers.close(second.id);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(!events.some(event => event.method === 'desktop/lsp-exit' && event.params.id === second.id));
});

test('a server that is not installed says how to get one; starting a kind again replaces its old server', async () => {
  const servers = new LanguageServers({ emit: () => {}, env: { PATH: '', HOME: project() }, execPath: process.execPath, bundled: () => ({ cli: fake, tsserver: '' }) });
  assert.throws(() => servers.start(project(), 'python'), /No Python language server was found\. Install Pyright/);
  const workspace = project();
  const first = servers.start(workspace, 'typescript');
  const second = servers.start(workspace, 'typescript');
  assert.notEqual(first.id, second.id);
  assert.throws(() => servers.send(first.id, '{"jsonrpc":"2.0","method":"x"}'), /no longer running/);
  servers.closeAll();
  assert.equal(findExecutable('definitely-not-a-real-tool', [tmpdir()]), null);
});

test('language server IPC names a known kind and carries bounded messages', () => {
  validateArguments('lspStart', ['/w', 'rust']);
  validateArguments('lspSend', ['00000000-0000-0000-0000-000000000000', '{}']);
  for (const [method, args] of [['lspStart', ['/w', 'cobol']], ['lspStart', ['/w', '__proto__']], ['lspSend', ['nope', '{}']], ['lspSend', ['00000000-0000-0000-0000-000000000000', 5]]])
    assert.throws(() => validateArguments(method, args), /Invalid desktop API arguments/, `${method} ${JSON.stringify(args)}`);
});

test('files map to their server and language, URIs to project paths, and edits apply to text', () => {
  assert.deepEqual(languageServerFor('src/App.tsx'), { kind: 'typescript', languageId: 'typescriptreact' });
  assert.deepEqual(languageServerFor('a/b.cpp'), { kind: 'c', languageId: 'cpp' });
  assert.equal(languageServerFor('README.md'), null);
  assert.equal(fileUri('/Users/me/My Project/a#b.ts'), 'file:///Users/me/My%20Project/a%23b.ts');
  assert.equal(fileUri('C:\\Work\\app'), 'file:///C:/Work/app');
  assert.equal(uriKey('file:///c%3A/Work/app'), uriKey('file:///C:/Work/app'));
  assert.equal(projectPath('file:///Users/me/My%20Project/src/a.ts', '/Users/me/My Project'), 'src/a.ts');
  assert.equal(projectPath('file:///Users/me/My%20Projects/a.ts', '/Users/me/My Project'), null, 'a sibling folder with a longer name is outside');
  assert.equal(projectPath('file:///c%3A/work/app/x.ts', 'C:\\Work\\App'), 'x.ts', 'Windows paths compare without case');
  assert.equal(projectPath('file:///usr/lib/node/lib.d.ts', '/Users/me/p'), null);
  const text = 'const foo = 1;\nfoo + foo;\n';
  const at = (line, character) => ({ line, character });
  assert.equal(applyTextEdits(text, [{ range: { start: at(0, 6), end: at(0, 9) }, newText: 'bar' }, { range: { start: at(1, 0), end: at(1, 3) }, newText: 'bar' }, { range: { start: at(1, 6), end: at(1, 9) }, newText: 'bar' }]), 'const bar = 1;\nbar + bar;\n');
  const edits = editsByUri({ documentChanges: [{ textDocument: { uri: 'file:///a' }, edits: [{ range: { start: at(0, 0), end: at(0, 0) }, newText: 'x' }] }, { kind: 'rename' }] });
  assert.deepEqual([...edits.keys()], ['file:///a']);
  assert.deepEqual([...editsByUri({ changes: { 'file:///b': [] } }).keys()], ['file:///b']);
});

test('the bundled TypeScript server finds definitions across files in a real project', { timeout: 60000 }, async () => {
  const workspace = project();
  writeFileSync(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', target: 'es2022', moduleResolution: 'bundler' } }));
  writeFileSync(path.join(workspace, 'math.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
  const mainText = "import { add } from './math';\nconst total: string = add(1, 2);\n";
  writeFileSync(path.join(workspace, 'main.ts'), mainText);
  const { emit, next } = inbox();
  // Under Node the bundled server runs as it does under Electron's Node mode.
  const servers = new LanguageServers({ emit, execPath: process.execPath, bundled: () => ({ cli: require.resolve('typescript-language-server/lib/cli.mjs'), tsserver: require.resolve('typescript/lib/tsserver.js') }) });
  const { id } = servers.start(workspace, 'typescript');
  let requestId = 0;
  const request = async (method, params) => {
    const sent = ++requestId;
    servers.send(id, JSON.stringify({ jsonrpc: '2.0', id: sent, method, params }));
    const reply = message(await next(event => event.method === 'desktop/lsp-message' && message(event).id === sent && !message(event).method, 45000));
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  };
  try {
    const init = await request('initialize', { processId: null, rootUri: null, capabilities: { textDocument: { publishDiagnostics: {} } } });
    assert.ok(init.capabilities.definitionProvider);
    servers.send(id, JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
    const uri = pathToFileURL(path.join(workspace, 'main.ts')).href;
    servers.send(id, JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'typescript', version: 0, text: mainText } } }));
    // Type errors arrive as diagnostics once the project has loaded; the syntax check alone could never find them.
    const diagnostics = message(await next(event => event.method === 'desktop/lsp-message' && message(event).method === 'textDocument/publishDiagnostics' && message(event).params.diagnostics.length > 0, 45000));
    assert.ok(diagnostics.params.diagnostics.some(item => item.message === "Type 'number' is not assignable to type 'string'."));
    const definition = await request('textDocument/definition', { textDocument: { uri }, position: { line: 1, character: 23 } });
    const location = Array.isArray(definition) ? definition[0] : definition;
    // Windows drive-letter casing can differ in the server's URI for the same file.
    const definitionPath = fileURLToPath(location.uri ?? location.targetUri);
    assert.equal(path.relative(path.join(workspace, 'math.ts'), definitionPath), '');
  } finally { servers.closeAll(); }
});
