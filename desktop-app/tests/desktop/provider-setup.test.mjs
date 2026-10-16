import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopBackend } from '../../electron/backend.mjs';

test('first-run provider setup needs no chat and closes the management process', async () => {
  const calls = [];
  let disposed = 0;
  const backend = new DesktopBackend({
    probe: async () => false,
    clientFactory(options) {
      assert.equal(options.env.HANDWORK_AUTH_MODE, 'host-managed');
      let exited;
      return {
        exited: new Promise(resolve => { exited = resolve; }),
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === 'initialize') return { agentCapabilities: { handwork: { backgroundTask: true } } };
          return { providers: [{ id: 'openai', connected: method.endsWith('/connect') }] };
        },
        dispose() { disposed++; exited(); },
      };
    },
  });
  assert.equal((await backend.listProviders()).providers[0].id, 'openai');
  assert.equal((await backend.connectProvider('openai', 'fixture-key')).providers[0].connected, true);
  await backend.disconnectProvider('openai');
  assert.equal(disposed, 3);
  assert.equal(backend.settingsClients.size, 0);
  assert.equal(backend.session, null);
  assert.equal(backend.engines.size, 0);
  assert.deepEqual(calls.map(call => call.method), [
    'initialize', 'handwork/providers/list',
    'initialize', 'handwork/providers/connect',
    'initialize', 'handwork/providers/disconnect',
  ]);
  assert.equal(calls[2].params.clientCapabilities.handwork.backgroundTask, true);
  assert.deepEqual(calls[3].params, { provider: 'openai', apiKey: 'fixture-key' });
  await backend.dispose();
});

test('failed first-run provider requests release the management process', async () => {
  let disposed = false;
  const backend = new DesktopBackend({ clientFactory: () => ({
    exited: Promise.resolve(),
    async request() { throw new Error('Engine unavailable'); },
    dispose() { disposed = true; },
  }) });
  await assert.rejects(backend.listProviders(), /Engine unavailable/);
  assert.equal(disposed, true);
  assert.equal(backend.settingsClients.size, 0);
  await backend.dispose();
});
