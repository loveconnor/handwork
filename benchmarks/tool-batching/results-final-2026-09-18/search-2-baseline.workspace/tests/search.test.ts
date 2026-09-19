import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchApi } from '../src/api/search.ts';
import { createSearchController } from '../src/search/controller.ts';
import { mountSearchView } from '../src/ui/search-view.ts';
import type { SearchElements } from '../src/ui/search-view.ts';

const items = [{ id: '1', title: 'React guide', url: '/guides/react' }];

test('initial state and empty input', async () => {
  const c = createSearchController({ search: async () => items });
  assert.deepEqual(c.getState(), { query: '', results: [], loading: false, error: null });
  await c.search('  ');
  assert.deepEqual(c.getState(), { query: '', results: [], loading: false, error: null });
});

test('ordinary API request encodes the query and displays results', async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ items }) };
  }) as unknown as typeof fetch;
  const c = createSearchController(createSearchApi(fetcher));
  await c.search(' react hooks ');
  assert.deepEqual(urls, ['/api/search?q=react%20hooks']);
  assert.deepEqual(c.getState(), { query: 'react hooks', results: items, loading: false, error: null });
});

test('ordinary failure becomes state and subscribers can unsubscribe', async () => {
  const c = createSearchController({ search: async () => { throw new Error('Offline'); } });
  let calls = 0;
  const unsubscribe = c.subscribe(() => { calls++; });
  await c.search('react');
  assert.equal(c.getState().error, 'Offline');
  assert.equal(c.getState().loading, false);
  assert.ok(calls >= 2);
  unsubscribe();
  const before = calls;
  await c.search('');
  assert.equal(calls, before);
});

test('view handles input, renders state and detaches listeners', async () => {
  const handlers = new Set<() => void>();
  const elements = {
    input: { value: '', addEventListener: (_: string, f: () => void) => handlers.add(f), removeEventListener: (_: string, f: () => void) => handlers.delete(f) },
    results: { textContent: '' }, loading: { hidden: true }, error: { textContent: '', hidden: true },
  };
  const c = createSearchController({ search: async () => items });
  let pending = Promise.resolve();
  const viewController = { ...c, search: (query: string) => (pending = c.search(query)) };
  const dispose = mountSearchView(viewController, elements as unknown as SearchElements);
  elements.input.value = 'react';
  for (const f of handlers) f();
  assert.equal(elements.loading.hidden, false);
  await pending;
  assert.equal(elements.results.textContent, 'React guide');
  assert.equal(elements.loading.hidden, true);
  assert.equal(elements.error.hidden, true);
  dispose();
  assert.equal(handlers.size, 0);
});
