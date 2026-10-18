import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { queueConfiguration } from '../../lib/configuration-queue.ts';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('a send capturing the configuration tail waits for both provider and requested model', async () => {
  const provider = deferred();
  const model = deferred();
  const calls = [];
  const tail = queueConfiguration(Promise.resolve(true), [['provider', 'other'], ['model', 'requested']], async (id, value) => {
    calls.push([id, value]);
    await (id === 'provider' ? provider.promise : model.promise);
    return value;
  });
  let sent = false;
  const send = tail.then(() => { sent = true; calls.push(['send', 'requested']); });
  await Promise.resolve();
  assert.deepEqual(calls, [['provider', 'other']]);
  provider.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['provider', 'other'], ['model', 'requested']]);
  assert.equal(sent, false);
  model.resolve();
  assert.deepEqual(await tail, ['other', 'requested']);
  await send;
  assert.equal(sent, true);
});

test('failed provider configuration never selects a model or dispatches a waiting send', async () => {
  const calls = [];
  const tail = queueConfiguration(Promise.resolve(), [['provider', 'bad'], ['model', 'requested']], async id => {
    calls.push(id);
    throw new Error('Provider unavailable');
  });
  await assert.rejects(tail.then(() => calls.push('send')), /Provider unavailable/);
  assert.deepEqual(calls, ['provider']);
});

test('later selections cannot interleave with an earlier provider/model transaction', async () => {
  const calls = [];
  const apply = async (id, value) => { calls.push([id, value]); return value; };
  const first = queueConfiguration(Promise.resolve(), [['provider', 'a'], ['model', 'a2']], apply);
  const last = queueConfiguration(first, [['provider', 'b'], ['model', 'b3']], apply);
  await last;
  assert.deepEqual(calls, [['provider', 'a'], ['model', 'a2'], ['provider', 'b'], ['model', 'b3']]);
  const source = readFileSync(new URL('../../components/site/HandworkHarness.tsx', import.meta.url), 'utf8');
  assert.match(source, /return configureChanges\(changes\)/);
  assert.match(source, /running\.current\.has\(activeSession\.current\)/);
});
