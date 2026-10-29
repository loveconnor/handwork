import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeClient, discoverClaudeModels } from '../../electron/claude-client.mjs';

const catalogue = [{ value: 'sonnet', displayName: 'Sonnet Test', resolvedModel: 'claude-sonnet-test', description: 'From CLI', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }, { value: 'custom-model', displayName: 'Custom Model', description: 'From CLI' }];
const discover = async () => catalogue;

function fixture(t, query) {
  const directory = mkdtempSync(path.join(tmpdir(), 'handwork-claude-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const native = new EventEmitter();
  native.exited = new Promise(() => {});
  native.cancelPermissions = () => {}; native.dispose = () => {}; native.send = () => {};
  native.request = async method => {
    if (method === 'session/new') return { sessionId: 'fixture', configOptions: [{ id: 'provider', options: [{ value: 'codex', name: 'Codex' }] }] };
    if (method === 'session/list') return { sessions: [] };
    if (method === 'handwork/providers/list') return { providers: [{ id: 'codex' }] };
    if (method === 'handwork/session/read') native.emit('event', { method: 'handwork/session_read_update', params: { sessionId: 'old', update: { sessionUpdate: 'user_message_chunk' } } });
    return {};
  };
  const client = new ClaudeClient({ cwd: directory }, { native, directory, query, discover, status: async () => true, locate: async () => '/fixture/claude' });
  return { client, native, directory };
}
async function select(client) {
  await client.request('session/new');
  return client.request('session/set_config_option', { sessionId: 'fixture', configId: 'provider', value: 'claude' });
}
function stream(generator) { return { [Symbol.asyncIterator]: generator, close() {} }; }

test('Claude is listed separately and can be selected in new chats', async t => {
  const { client } = fixture(t);
  assert.equal((await client.request('handwork/providers/list')).providers.at(-1).id, 'claude');
  assert.equal((await client.request('session/new')).configOptions[0].options.at(-1).value, 'claude');
  assert.equal((await select(client)).configOptions[0].currentValue, 'claude');
});

test('streamed replies, tools, and resume IDs survive reload', async t => {
  let calls = 0;
  const { client, native, directory } = fixture(t, ({ options }) => stream(async function* () {
    assert.equal(options.permissionMode, 'default');
    if (calls++) assert.equal(options.resume, 'claude-session');
    yield { type: 'system', session_id: 'claude-session' };
    yield { type: 'stream_event', event: { type: 'message_start', message: { id: 'answer' } } };
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } };
    yield { type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: 'README.md' } }] } };
    yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'read' }] } };
    yield { type: 'result', is_error: false };
  }));
  await select(client);
  assert.equal((await client.request('session/prompt', { sessionId: 'fixture', prompt: [{ type: 'text', text: 'Hi' }] })).stopReason, 'end_turn');
  const saved = client.read('fixture');
  assert.equal(saved.updates.filter(item => item.sessionUpdate === 'agent_message_chunk').length, 1);
  assert.equal(saved.updates.find(item => item.sessionUpdate === 'tool_call_update').status, 'completed');
  assert.equal((await client.request('session/list')).sessions[0].title, 'Hi');
  const reopened = new ClaudeClient({}, { native, directory, discover, query: client.query, locate: client.locate });
  await reopened.request('session/load', { sessionId: 'fixture' });
  await reopened.request('session/prompt', { sessionId: 'fixture', prompt: [{ type: 'text', text: 'Again' }] });
  let history = 0;
  reopened.on('event', event => { if (event.method === 'handwork/session_read_update') history++; });
  await reopened.request('handwork/session/read', { sessionId: 'fixture' });
  assert.ok(history > 2);
  await reopened.request('session/remove', { sessionId: 'fixture' });
  assert.equal(reopened.read('fixture'), null);
});

test('permissions require an explicit response and cancellation denies pending tools', async t => {
  const { client } = fixture(t);
  await select(client);
  const controller = new AbortController();
  let request;
  client.on('event', event => { if (event.method === 'session/request_permission') request = event; });
  const permission = client.permission('Bash', { command: 'pwd' }, { signal: controller.signal, toolUseID: 'tool' });
  client.respondPermission(request.id, 'allow');
  assert.equal((await permission).behavior, 'allow');
  const denied = client.permission('Bash', {}, { signal: controller.signal });
  client.cancelPermissions();
  assert.equal((await denied).behavior, 'deny');
});

test('existing native chats cannot silently lose their history', async t => {
  const { client } = fixture(t);
  await assert.rejects(client.request('session/set_config_option', { sessionId: 'old', configId: 'provider', value: 'claude' }), /Start a new chat/);
  assert.equal(client.session, null);
});

test('provider failures surface and release the running query', async t => {
  const { client } = fixture(t, () => stream(async function* () { yield { type: 'result', is_error: true, errors: ['Login expired'] }; }));
  await select(client);
  await assert.rejects(client.request('session/prompt', { sessionId: 'fixture', prompt: [{ type: 'text', text: 'Hi' }] }), /Login expired/);
  assert.equal(client.controller, null);
});

test('saved desktop permission defaults map to Claude plan mode', async t => {
  const { client } = fixture(t, ({ options }) => stream(async function* () {
    assert.equal(options.permissionMode, 'plan');
    yield { type: 'result', is_error: false };
  }));
  await select(client);
  await client.request('session/set_config_option', { sessionId: 'fixture', configId: 'mode', value: 'code' });
  await client.request('session/set_config_option', { sessionId: 'fixture', configId: 'mode', value: 'ask' });
  await client.request('session/prompt', { sessionId: 'fixture', prompt: [{ type: 'text', text: 'Plan' }] });
});

test('cancelling a running prompt releases it without reporting success', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const { client } = fixture(t, ({ options }) => stream(async function* () {
    started();
    await new Promise(resolve => options.abortController.signal.addEventListener('abort', resolve, { once: true }));
  }));
  await select(client);
  const pending = client.request('session/prompt', { sessionId: 'fixture', prompt: [{ type: 'text', text: 'Wait' }] });
  await ready;
  client.send({ method: 'session/cancel', params: { sessionId: 'fixture' } });
  assert.equal((await pending).stopReason, 'cancelled');
  assert.equal(client.controller, null);
});

test('Claude conversations participate in saved-chat search', async t => {
  const { ChatSearchIndex } = await import('../../electron/chat-search.mjs');
  const { client, directory } = fixture(t, () => stream(async function* () {
    yield { type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: 'The migration is ready.' }] } };
    yield { type: 'result', is_error: false };
  }));
  await select(client);
  await client.request('session/prompt', { sessionId: 'fixture', prompt: [{ type: 'text', text: 'Help' }] });
  const result = await new ChatSearchIndex(directory).search('migration');
  assert.equal(result.results[0].sessionId, 'fixture');
});

test('model discovery uses SDK metadata without sending a prompt and always closes', async () => {
  let closed = 0;
  const result = await discoverClaudeModels({ locate: async () => '/unmodified/claude', query: ({ prompt, options }) => {
    assert.equal(typeof prompt, 'object');
    assert.equal(options.pathToClaudeCodeExecutable, '/unmodified/claude');
    assert.equal(options.persistSession, false);
    return { supportedModels: async () => catalogue, close() { closed++; } };
  } });
  assert.equal(result[0].resolvedModel, 'claude-sonnet-test');
  assert.equal(closed, 1);
  await assert.rejects(discoverClaudeModels({ locate: async () => '/claude', query: () => ({ supportedModels: async () => [], close() { closed++; } }) }), /no models/);
  assert.equal(closed, 2);
  await assert.rejects(discoverClaudeModels({ timeout: 5, locate: async () => '/claude', query: () => ({ supportedModels: () => new Promise(() => {}), close() { closed++; } }) }), /timed out/);
  assert.equal(closed, 3);
});

test('model names, descriptions, and effort choices come from the discovered catalogue', async t => {
  let sent;
  const { client } = fixture(t, ({ options }) => { sent = options; return stream(async function* () { yield { type: 'result' }; }); });
  const result = await select(client);
  const model = result.configOptions.find(item => item.id === 'model');
  assert.equal(model.options[0].name, 'Sonnet Test');
  assert.match(model.options[0].description, /claude-sonnet-test/);
  assert.deepEqual(result.configOptions.find(item => item.id === 'effort').options.map(item => item.value), ['auto', 'low', 'high']);
  await assert.rejects(client.request('session/set_config_option', { sessionId: 'fixture', configId: 'effort', value: 'max' }), /not supported/);
  await client.request('session/set_config_option', { sessionId: 'fixture', configId: 'effort', value: 'high' });
  await client.request('session/prompt', { sessionId: 'fixture', prompt: [{ type: 'text', text: 'Hi' }] });
  assert.equal(sent.effort, 'high');
  const changed = await client.request('session/set_config_option', { sessionId: 'fixture', configId: 'model', value: 'custom-model' });
  assert.equal(changed.configOptions.some(item => item.id === 'effort'), false);
  assert.equal(client.session.effort, undefined);
  await assert.rejects(client.request('session/set_config_option', { sessionId: 'fixture', configId: 'model', value: 'invented' }), /no longer reported/);
});

test('fast mode is opt-in and disappears for unsupported models', async t => {
  let sent;
  const { client } = fixture(t, ({ options }) => { sent = options; return stream(async function* () { yield { type: 'result' }; }); });
  client.discover = async () => [{ ...catalogue[0], supportsFastMode: true }, catalogue[1]];
  assert.equal((await select(client)).configOptions.find(item => item.id === 'fast_mode').currentValue, 'off');
  await client.request('session/set_config_option', { sessionId: 'fixture', configId: 'fast_mode', value: 'on' });
  await client.request('session/prompt', { sessionId: 'fixture', prompt: [{ type: 'text', text: 'Hi' }] });
  assert.equal(sent.settings.fastMode, true);
  await client.request('session/set_config_option', { sessionId: 'fixture', configId: 'model', value: 'custom-model' });
  assert.equal(client.config().some(item => item.id === 'fast_mode'), false);
  assert.equal(client.session.fast, undefined);
});

test('context display uses the last response usage, not cumulative turn totals', async t => {
  const { client } = fixture(t, () => stream(async function* () {
    yield { type: 'assistant', message: { id: 'a', model: 'claude-test', usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 }, content: [{ type: 'text', text: 'Done' }] } };
    yield { type: 'result', modelUsage: { 'claude-test': { contextWindow: 200000, inputTokens: 1000 } } };
  }));
  await select(client);
  await client.request('session/prompt', { sessionId: 'fixture', prompt: [{ type: 'text', text: 'Hi' }] });
  const usage = client.session.updates.find(item => item.sessionUpdate === 'usage_update');
  assert.equal(usage.used, 65);
  assert.equal(usage.size, 200000);
});

test('default alias is hidden and existing selections migrate to its concrete model', async t => {
  const { concreteClaudeModels } = await import('../../electron/claude-client.mjs');
  const rows = [{ value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-test' }, ...catalogue, { value: 'opus', displayName: 'Opus Test', resolvedModel: 'claude-opus-test' }];
  assert.equal(concreteClaudeModels(rows)[0].value, 'opus');
  assert.equal(concreteClaudeModels(rows).some(row => row.value === 'default'), false);
  const { client } = fixture(t);
  client.discover = async () => rows;
  await select(client);
  assert.equal(client.session.model, 'opus');
  client.session.model = 'default';
  client.session.models = rows;
  assert.equal(client.config()[1].currentValue, 'opus');
  assert.equal(client.config()[1].options.some(row => row.value === 'default'), false);
  await client.refreshModels();
  assert.equal(client.session.model, 'opus');
  await client.request('session/set_config_option', { sessionId: 'fixture', configId: 'model', value: 'default' });
  assert.equal(client.session.model, 'opus', 'legacy desktop preferences restore the migrated model');
  assert.equal(concreteClaudeModels([rows[0]])[0].value, 'claude-opus-test');
});
