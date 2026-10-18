import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { canAutoRecover, canContinueRecovery, continuationParams, requestWithRecovery } from '../../electron/response-recovery.mjs';
import { DesktopBackend } from '../../electron/backend.mjs';
import { applyUpdate, emptyConversation } from '../../lib/desktop-state.ts';
import { validateArguments } from '../../electron/ipc.mjs';
import { isResponseError } from '../../lib/response-error.ts';

const paused = { state: 'paused', durable: true, requiredAction: 'continue_later', cause: 'network_interrupted', attempt: 1, attemptLimit: 10, message: 'Network interrupted. Recovery paused.' };
const info = recovery => ({ sessionUpdate: 'session_info_update', _meta: { handwork: { modelResponseRecovery: recovery } } });

test('provider failure notices are recognized without treating explanations or code as errors', () => {
  assert.equal(isResponseError('provider_error: Provider response failed'), true);
  assert.equal(isResponseError(' Provider response failed.\n'), true);
  for (const reply of ['Here is how to fix provider_error: Provider response failed', '```\nprovider_error: Provider response failed\n```', 'The response is complete.']) {
    assert.equal(isResponseError(reply), false);
  }
});

test('recovery projection preserves ordinary updates and clears resolved or null status', () => {
  const state = applyUpdate(emptyConversation(), info(paused));
  assert.equal(state.recovery, paused.message);
  assert.equal(state.canContinue, true);
  assert.equal(applyUpdate(state, { sessionUpdate: 'session_info_update', title: 'New title' }).canContinue, true);
  for (const recovery of [null, { ...paused, state: 'recovered' }]) {
    const cleared = applyUpdate(state, info(recovery));
    assert.equal(cleared.recovery, undefined);
    assert.equal(cleared.canContinue, false);
  }
  for (const recovery of [{ ...paused, state: 'active' }, { ...paused, durable: false }, { ...paused, requiredAction: 'inspect_uncertain_tool' }]) {
    assert.equal(applyUpdate(state, info(recovery)).canContinue, false);
  }
});

test('automatic recovery is limited to safe temporary interruptions within the engine budget', () => {
  assert.equal(canAutoRecover(paused), true);
  for (const recovery of [undefined, { ...paused, state: 'active' }, { ...paused, durable: false }, { ...paused, requiredAction: 'inspect_uncertain_tool' }, { ...paused, requiredAction: 'change_request' }, { ...paused, cause: 'authentication' }, { ...paused, cause: 'rate_limited' }, { ...paused, attempt: 10 }]) {
    assert.equal(canAutoRecover(recovery), false);
  }
  assert.equal(canContinueRecovery({ ...paused, attempt: 10 }), true, 'manual continuation remains available');
});

test('automatic retries resume the checkpoint without resending the original prompt or attachments', async () => {
  const requests = []; const delays = []; const statuses = [];
  const engine = { client: { async request(method, params) {
    requests.push([method, params]);
    if (requests.length === 1) engine.recovery = paused;
    return { stopReason: requests.length === 1 ? 'refused' : 'end_turn' };
  } } };
  const original = { sessionId: 'chat-1', prompt: [{ type: 'text', text: 'Make a change' }, { type: 'image', data: 'abc', mimeType: 'image/png' }] };
  const result = await requestWithRecovery(engine, original, { wait: async ms => delays.push(ms), onWaiting: status => statuses.push(status) });
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(requests, [['session/prompt', original], ['session/prompt', continuationParams('chat-1')]]);
  assert.deepEqual(delays, [2000]);
  assert.equal(statuses[0].state, 'active');
});

test('repeated failures stop after two delayed retries and keep the checkpoint for the button', async () => {
  let calls = 0; const delays = [];
  const engine = { client: { async request() { calls++; engine.recovery = paused; return { stopReason: 'refused' }; } } };
  await requestWithRecovery(engine, { sessionId: 'chat-1', prompt: [] }, { wait: async ms => delays.push(ms) });
  assert.equal(calls, 3);
  assert.deepEqual(delays, [2000, 5000]);
  assert.equal(canContinueRecovery(engine.recovery), true);
});

test('cancellation during backoff and a closed engine prevent another request', async () => {
  for (const close of [false, true]) {
    let calls = 0;
    const engine = { client: { async request() { calls++; engine.recovery = paused; return { stopReason: 'refused' }; } } };
    const result = await requestWithRecovery(engine, { sessionId: 'chat-1' }, { wait: async () => { if (close) engine.client.closed = true; else engine.cancelling = true; } });
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(calls, 1);
  }
});

test('ordinary transport errors and user cancellation never replay a prompt', async () => {
  let calls = 0;
  const engine = { client: { async request() { calls++; throw new Error('connection lost'); } } };
  await assert.rejects(requestWithRecovery(engine, { sessionId: 'chat-1' }), /connection lost/);
  assert.equal(calls, 1);
  engine.client.request = async () => { engine.recovery = paused; return { stopReason: 'cancelled' }; };
  assert.equal((await requestWithRecovery(engine, {}, { wait: () => assert.fail('must not retry cancellation') })).stopReason, 'cancelled');
});

test('backend tracks engine recovery events and manual retry continues the same session', async () => {
  const requests = []; const events = [];
  const client = new EventEmitter();
  client.exited = new Promise(() => {});
  client.cancelPermissions = () => {};
  client.request = async (method, params) => {
    requests.push([method, params]);
    if (method === 'initialize') return { protocolVersion: 1 };
    client.emit('event', { method: 'session/update', params: { sessionId: 'chat-1', update: info(null) } });
    return { stopReason: 'end_turn' };
  };
  const backend = new DesktopBackend({ clientFactory: () => client });
  const engine = await backend.openEngine('/project');
  engine.session = { sessionId: 'chat-1' };
  backend.on('event', event => events.push(event));
  client.emit('event', { method: 'session/update', params: { sessionId: 'chat-1', update: info(paused) } });
  assert.deepEqual(engine.recovery, paused);
  const result = await backend.continueResponse('chat-1');
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(requests.at(-1), ['session/prompt', continuationParams('chat-1')]);
  assert.equal(engine.prompting, false);
  assert.equal(engine.running, false);
  assert.equal(events.at(-1).params.update._meta.handwork.modelResponseRecovery, null);
  await assert.rejects(backend.continueResponse('chat-1'), /No paused response/);
  engine.recovery = { ...paused, requiredAction: 'inspect_uncertain_tool' };
  await assert.rejects(backend.continueResponse('chat-1'), /No paused response/);
  engine.recovery = paused; engine.running = true;
  await assert.rejects(backend.continueResponse('chat-1'), /busy/);
});

test('failed requests clear stale retry status and release the session lock', async () => {
  const backend = new DesktopBackend({});
  const events = [];
  backend.on('event', event => events.push(event));
  const engine = { session: { sessionId: 'chat-1' }, client: { cancelPermissions() {}, async request() { throw new Error('disconnected'); } } };
  backend.engines.add(engine);
  await assert.rejects(backend.prompt('hello', [], 'chat-1'), /disconnected/);
  assert.equal(engine.running, false);
  assert.equal(engine.prompting, false);
  assert.equal(events.at(-1).params.update._meta.handwork.modelResponseRecovery, null);
});

test('continuation IPC accepts only an optional validated session ID', () => {
  validateArguments('continueResponse', []);
  validateArguments('continueResponse', ['chat-1']);
  for (const args of [['../chat'], [{}], ['chat-1', 'prompt'], [null]]) assert.throws(() => validateArguments('continueResponse', args), /Invalid desktop/);
});
