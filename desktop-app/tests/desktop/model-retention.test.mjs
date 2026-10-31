import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopBackend } from '../../electron/backend.mjs';
import { ChatPreferences } from '../../electron/chat-preferences.mjs';

const options = (provider = 'first', model = 'default') => [
  { id: 'provider', currentValue: provider },
  { id: 'model', currentValue: model },
  { id: 'effort', currentValue: 'high' },
];

function backend(preferences = new ChatPreferences()) {
  const app = new DesktopBackend({ settingsService: { home: tmpdir() }, chatPreferences: preferences });
  const requests = [];
  app.listCachedSessions = () => {};
  app.recentSessions = ['a', 'b'].map(sessionId => ({ sessionId, cwd: '/project' }));
  app.openEngine = async workspace => {
    let config = options();
    const client = {
      closed: false,
      dispose() { this.closed = true; },
      async request(method, params) {
        requests.push({ method, ...params });
        if (method === 'session/set_config_option') {
          if (params.value === 'invalid') throw new Error('Unknown model');
          config = params.configId === 'provider' ? options(params.value) : config.map(option => option.id === params.configId ? { ...option, currentValue: params.value } : option);
        }
        return { configOptions: config };
      },
    };
    const engine = { client, workspace, session: null };
    app.engines.add(engine);
    return engine;
  };
  return { app, requests };
}

const currentModel = result => result.configOptions.find(option => option.id === 'model').currentValue;

test('each live chat retains its model when switching back and forth', async () => {
  const { app, requests } = backend();
  await app.loadSession('a');
  await app.setConfig('model', 'chosen-a');
  await app.loadSession('b');
  await app.setConfig('model', 'chosen-b');
  assert.equal(currentModel(await app.loadSession('a')), 'chosen-a');
  assert.equal(currentModel(await app.loadSession('b')), 'chosen-b');
  assert.equal(requests.filter(request => request.method === 'session/load').length, 2);
});

test('reload restores the saved provider before the model and preserves chat metadata', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'handwork-model-retention-'));
  try {
    const file = path.join(directory, 'preferences.json');
    const preferences = new ChatPreferences(file);
    preferences.update('a', { title: 'My chat', pinned: true });
    const first = backend(preferences);
    await first.app.loadSession('a');
    await first.app.setConfig('provider', 'second');
    await first.app.setConfig('model', 'chosen');
    const restarted = backend(new ChatPreferences(file));
    assert.equal(currentModel(await restarted.app.loadSession('a')), 'chosen');
    assert.deepEqual(restarted.requests.filter(request => request.method === 'session/set_config_option').map(request => [request.configId, request.value]), [['provider', 'second'], ['model', 'chosen']]);
    assert.equal(currentModel(await restarted.app.loadSession('b')), 'default');
    assert.equal(preferences.list().a.title, 'My chat');
    assert.equal(preferences.list().a.pinned, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('failed model changes do not replace the saved selection', async () => {
  const { app } = backend();
  await app.loadSession('a');
  await app.setConfig('model', 'chosen');
  await assert.rejects(app.setConfig('model', 'invalid'), /Unknown model/);
  assert.equal(app.chatPreferences.list().a.config.model, 'chosen');
  const engine = app.engineFor('a');
  engine.client.closed = true;
  assert.equal(currentModel(await app.loadSession('a')), 'chosen');
});
