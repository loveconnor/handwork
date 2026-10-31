import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { DesktopBackend } from '../../electron/backend.mjs';

const source = readFileSync(new URL('../../lib/provider-startup.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace("'./desktop-state'", JSON.stringify(new URL('../../lib/desktop-state.ts', import.meta.url).href));
const { cachedProviders, cacheProviders, cachedProviderOptions, cacheProviderOptions, visibleProviderOptions } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const store = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values }; };
const providers = [{ id: 'codex', name: 'Codex', connected: true, signIn: 'browser' }, { id: 'claude', name: 'Claude Code', connected: true, signIn: 'none' }];
const options = [{ id: 'provider', name: 'Provider', currentValue: 'codex', options: [{ value: 'codex', name: 'Codex' }] }, { id: 'model', name: 'Model', currentValue: 'model-a', options: [{ value: 'model-a', name: 'Model A' }] }];

test('provider and model snapshots are available synchronously on the next launch', () => {
  const storage = store();
  cacheProviders(providers.map(provider => ({ ...provider, apiKey: 'must-not-save', baseUrl: 'https://secret@example.test' })), storage);
  cacheProviderOptions(options, storage);
  assert.deepEqual(JSON.parse(JSON.stringify(cachedProviders(storage))), providers);
  assert.deepEqual(cachedProviderOptions(storage), options);
  assert.ok(![...storage.values.values()].join('').includes('secret'));
  assert.ok(![...storage.values.values()].join('').includes('must-not-save'));
  const menu = visibleProviderOptions(cachedProviderOptions(storage), cachedProviders(storage));
  assert.deepEqual(menu[0].options.map(item => item.value), ['codex', 'claude']);
  cacheProviders([{ ...providers[1], connected: false }], storage);
  assert.deepEqual(visibleProviderOptions(options, cachedProviders(storage))[0].options.map(item => item.value), ['codex']);
});

test('missing, damaged, and unavailable storage never blocks startup', () => {
  const broken = { getItem() { throw new Error('Unavailable'); }, setItem() { throw new Error('Unavailable'); } };
  assert.deepEqual(cachedProviders(broken), []);
  assert.deepEqual(cachedProviderOptions(broken), []);
  assert.doesNotThrow(() => cacheProviders(providers, broken));
  assert.doesNotThrow(() => cacheProviderOptions(options, broken));
  assert.deepEqual(cachedProviders({ getItem: () => '{broken' }), []);
});

test('startup provider discovery is independent of chat startup and coalesces callers', async () => {
  let resolveList, calls = 0, disposed = 0;
  const pending = new Promise(resolve => { resolveList = resolve; });
  const backend = new DesktopBackend({ clientFactory: () => ({ exited: Promise.resolve(), async request(method) {
    if (method === 'initialize') return { agentCapabilities: { handwork: { backgroundTask: true } } };
    calls++; return pending;
  }, dispose() { disposed++; } }) });
  backend.exclusive = () => { throw new Error('Must not queue behind startup'); };
  backend.client = { closed: false, request() { throw new Error('Must not use the active chat'); } };
  const first = backend.listProviders(), second = backend.listProviders();
  await Promise.resolve();
  resolveList({ providers });
  assert.deepEqual(await first, { providers });
  assert.deepEqual(await second, { providers });
  assert.equal(calls, 1);
  assert.equal(disposed, 1);
  await backend.dispose();
});
