import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelPreferences } from '../../electron/model-preferences.mjs';
import { DesktopBackend } from '../../electron/backend.mjs';
import { validateArguments } from '../../electron/ipc.mjs';
import { frecency, modelKey, modelShortcuts } from '../../lib/model-shortcuts.ts';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 9, 17);
const options = (provider = 'openai', model = 'gpt-a', models = ['gpt-a', 'gpt-b', 'gpt-c', 'gpt-d']) => [
  { id: 'provider', name: 'Provider', currentValue: provider, options: [{ value: 'openai', name: 'OpenAI' }, { value: 'anthropic', name: 'Anthropic' }] },
  { id: 'model', name: 'Model', currentValue: model, options: models.map(value => ({ value, name: value.toUpperCase() })) },
];
const use = (provider, model, count, daysAgo) => ({ provider, model, name: model, count, lastUsed: now - daysAgo * DAY });

test('recent use outweighs old use, and old single uses fade out', () => {
  assert.equal(frecency({ count: 4, lastUsed: now }, now), 4);
  assert.equal(frecency({ count: 4, lastUsed: now - 14 * DAY }, now), 2);
  assert.ok(frecency({ count: 1, lastUsed: now - 60 * DAY }, now) < 0.25);
});

test('shortcuts list available favorites, then frequent models excluding the current one', () => {
  const preferences = {
    favorites: [{ provider: 'anthropic', model: 'claude', name: 'Claude' }, { provider: 'openai', model: 'gpt-b', name: 'old name' }, { provider: 'openai', model: 'retired', name: 'Retired' }, { provider: 'offline', model: 'm', name: 'M' }],
    usage: [use('openai', 'gpt-a', 50, 0), use('openai', 'gpt-b', 20, 0), use('openai', 'gpt-c', 3, 1), use('openai', 'gpt-d', 9, 0), use('openai', 'stale', 1, 90), use('anthropic', 'haiku', 2, 3)],
  };
  const result = modelShortcuts(preferences, options(), { now });
  assert.deepEqual(result.favorites.map(item => item.key), [modelKey('anthropic', 'claude'), modelKey('openai', 'gpt-b')], 'retired models and disconnected providers are hidden');
  assert.equal(result.favorites[1].name, 'GPT-B', 'the current provider supplies the latest name');
  assert.deepEqual(result.frequent.map(item => item.model), ['gpt-d', 'gpt-c', 'haiku'], 'the current model, favorites, and faded models are left out');
  assert.equal(result.favorite, false);
  const onFavorite = modelShortcuts(preferences, options('openai', 'gpt-b'), { now });
  assert.equal(onFavorite.favorite, true);
  assert.equal(onFavorite.favorites[1].current, true);
  assert.deepEqual(modelShortcuts(undefined, options()), { favorites: [], frequent: [], favorite: false });
  assert.deepEqual(modelShortcuts(preferences, options().slice(0, 1)).frequent, [], 'nothing is offered without a model list');
});

test('model preferences persist favorites and bounded usage without prompt content', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'handwork-models-'));
  try {
    const file = path.join(directory, 'model-preferences.json');
    const store = new ModelPreferences(file);
    store.recordUse('openai', 'gpt-a', 'GPT A', 1);
    store.recordUse('openai', 'gpt-a', 'GPT A', 2);
    store.setFavorite('openai', 'gpt-b', 'GPT B', true);
    store.setFavorite('openai', 'gpt-b', 'GPT B', true);
    const saved = new ModelPreferences(file).list();
    assert.deepEqual(saved.usage, [{ provider: 'openai', model: 'gpt-a', name: 'GPT A', count: 2, lastUsed: 2 }]);
    assert.deepEqual(saved.favorites, [{ provider: 'openai', model: 'gpt-b', name: 'GPT B' }], 'favoriting twice keeps one entry');
    for (let index = 0; index < 60; index++) store.recordUse('p', `m${index}`, '', 10 + index);
    assert.equal(store.list().usage.length, 50);
    assert.equal(store.list().usage[0].model, 'm59');
    assert.equal(store.list().usage[0].name, 'm59', 'a missing name falls back to the model ID');
    for (let index = 0; index < 29; index++) store.setFavorite('p', `f${index}`, 'F', true);
    assert.throws(() => store.setFavorite('p', 'one-too-many', 'F', true), /up to 30/);
    store.setFavorite('openai', 'gpt-b', 'GPT B', false);
    assert.ok(!store.list().favorites.some(item => item.model === 'gpt-b'));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
    writeFileSync(file, JSON.stringify({ favorites: 'broken', usage: [] }));
    assert.throws(() => store.list(), /Invalid model preferences/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('sending records the chat model and notifies the renderer, even with nested model groups', async () => {
  const backend = new DesktopBackend({ modelPreferences: new ModelPreferences() });
  const events = [];
  backend.on('event', event => { if (event.method === 'desktop/models') events.push(event.params); });
  const configOptions = [{ id: 'provider', currentValue: 'openai' }, { id: 'model', currentValue: 'gpt-b', options: [{ name: 'Recommended', options: [{ value: 'gpt-b', name: 'GPT B' }] }] }];
  const engine = { session: { sessionId: 'chat', configOptions }, client: { closed: false, cancelPermissions() {}, async request() { return { stopReason: 'end_turn' }; } } };
  backend.engines.add(engine);
  await backend.prompt('hello', [], 'chat');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].usage.map(({ provider, model, name, count }) => ({ provider, model, name, count })), [{ provider: 'openai', model: 'gpt-b', name: 'GPT B', count: 1 }]);
  backend.modelPreferences.list = () => { throw new Error('unreadable'); };
  await backend.prompt('again', [], 'chat');
  assert.equal(events.length, 1, 'an unreadable store never blocks sending');
});

test('favorite changes are validated before reaching the store', () => {
  assert.doesNotThrow(() => validateArguments('setModelFavorite', ['openai', 'gpt-b', 'GPT B', true]));
  assert.doesNotThrow(() => validateArguments('setModelFavorite', ['', 'local-model', 'Local', false]), 'engines without a provider option still allow favorites');
  for (const args of [['open ai', 'gpt', 'GPT', true], ['openai', '', 'GPT', true], ['openai', 'gpt\n', 'GPT', true], ['openai', 'gpt', 'GPT', 'yes'], ['openai', 'gpt', 'GPT']]) {
    assert.throws(() => validateArguments('setModelFavorite', args), /Invalid desktop API arguments/);
  }
  assert.doesNotThrow(() => validateArguments('getModelPreferences', []));
});
