import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// The real network is forbidden, even if an implementation stops using injection.
globalThis.fetch = () => { throw new Error('Verifier forbids real network requests'); };
const root = process.argv[2];
const { createSearchApi } = await import(pathToFileURL(path.join(root, 'src/api/search.ts')).href);
const { createSearchController } = await import(pathToFileURL(path.join(root, 'src/search/controller.ts')).href);
const { mountSearchView } = await import(pathToFileURL(path.join(root, 'src/ui/search-view.ts')).href);
const item = label => ({ id: label, title: `Result ${label}`, url: `/result/${label}` });
const permutations = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const requests = [], tasks = [], emissions = [], handlers = new Set();
  const fetcher = url => {
    const d = deferred();
    requests.push({ ...d, query: new URL(String(url), 'https://fixture.invalid').searchParams.get('q') });
    return d.promise;
  };
  const controller = createSearchController(createSearchApi(fetcher));
  const elements = {
    input: { value: '', addEventListener: (name, fn) => { assert.equal(name, 'input'); handlers.add(fn); }, removeEventListener: (_, fn) => handlers.delete(fn) },
    results: { textContent: '' }, loading: { hidden: true }, error: { textContent: '', hidden: true },
  };
  controller.subscribe(state => emissions.push(structuredClone(state)));
  const dispose = mountSearchView({ ...controller, search(query) {
    const task = controller.search(query); tasks.push(task); return task;
  } }, elements);
  function start(query) {
    const requestCount = requests.length, taskCount = tasks.length;
    elements.input.value = query;
    for (const handler of handlers) handler();
    assert.equal(tasks.length, taskCount + 1, 'input must start one controller search');
    return { task: tasks.at(-1), request: requests.length > requestCount ? requests.at(-1) : null };
  }
  function state(expected) {
    const current = controller.getState();
    assert.deepEqual(current, expected);
    assert.equal(elements.results.textContent, expected.results.map(r => r.title).join('\n'), 'view results');
    assert.equal(elements.loading.hidden, !expected.loading, 'view loading');
    assert.equal(elements.error.textContent, expected.error ?? '', 'view error');
    assert.equal(elements.error.hidden, expected.error === null, 'view error visibility');
  }
  async function finish(op, label, fail = false) {
    assert.ok(op.request, 'search should call the API');
    if (fail) op.request.reject(new Error(label));
    else op.request.resolve({ ok: true, status: 200, json: async () => ({ items: [item(label)] }) });
    await op.task;
  }
  async function stale(op, label, fail = false) {
    const before = structuredClone(controller.getState()), count = emissions.length;
    await finish(op, label, fail);
    state(before);
    assert.equal(emissions.length, count, 'stale completions must not publish state updates');
  }
  return { controller, elements, requests, emissions, start, state, finish, stale, dispose };
}

const expected = (query, results = [], loading = false, error = null) => ({ query, results, loading, error });
const checks = [];
async function check(name, fn) {
  try { await fn(); checks.push({ name, pass: true }); }
  catch (e) { checks.push({ name, pass: false, error: e.message }); }
}

await check('Ordinary search succeeds', async () => {
  const h = fixture(), op = h.start(' react hooks ');
  assert.equal(op.request.query, 'react hooks');
  h.state(expected('react hooks', [], true));
  await h.finish(op, 'ordinary');
  h.state(expected('react hooks', [item('ordinary')]));
  h.dispose();
});

await check('Older success arrives after newer success', async () => {
  const h = fixture(), old = h.start('react'), latest = h.start('react hooks');
  await h.finish(latest, 'latest'); h.state(expected('react hooks', [item('latest')]));
  await h.stale(old, 'old');
});

await check('Older success arrives while newer request is pending', async () => {
  const h = fixture(), old = h.start('react'), latest = h.start('react hooks');
  h.state(expected('react hooks', [], true));
  await h.stale(old, 'old');
  await h.finish(latest, 'latest'); h.state(expected('react hooks', [item('latest')]));
});

await check('Older failure arrives while newer request is pending', async () => {
  const h = fixture(), old = h.start('react'), latest = h.start('react hooks');
  h.state(expected('react hooks', [], true));
  await h.stale(old, 'Old error', true);
  await h.finish(latest, 'latest'); h.state(expected('react hooks', [item('latest')]));
});

await check('Latest request fails', async () => {
  const h = fixture(), old = h.start('react'), latest = h.start('react hooks');
  await h.finish(latest, 'Current error', true);
  h.state(expected('react hooks', [], false, 'Current error'));
  await h.stale(old, 'old');
  const retry = h.start('retry'); h.state(expected('retry', [], true));
  await h.finish(retry, 'retry'); h.state(expected('retry', [item('retry')]));
});

await check('Query cleared during a request', async () => {
  const h = fixture(), seed = h.start('seed');
  await h.finish(seed, 'seed');
  const pending = h.start('pending');
  h.state(expected('pending', [item('seed')], true));
  const count = h.requests.length, clear = h.start('   ');
  h.state(expected('')); // Deliberately assert before awaiting clear.task.
  assert.equal(h.requests.length, count, 'clearing must not send a search');
  await clear.task;
  await h.finish(pending, 'pending');
  // Clearing an existing error is also immediate.
  const error = h.start('error'); await h.finish(error, 'Visible error', true);
  const clearError = h.start(''); h.state(expected('')); await clearError.task;
});

await check('Pending request finishes after clearing', async () => {
  for (const fail of [false, true]) {
    const h = fixture(), pending = h.start('react');
    await h.start('').task; h.state(expected(''));
    await h.stale(pending, fail ? 'Old error' : 'old', fail);
    h.state(expected(''));
  }
});

await check('Query changes A → B → A', async () => {
  for (const order of permutations) {
    const h = fixture(), ops = ['A','B','A'].map(q => h.start(q));
    for (const index of order) {
      if (index === 2) {
        await h.finish(ops[index], 'final-A'); h.state(expected('A', [item('final-A')]));
      } else await h.stale(ops[index], index === 0 ? 'first-A' : 'B');
    }
    h.state(expected('A', [item('final-A')]));
  }
});

await check('Three requests complete in different orders', async () => {
  for (const order of permutations) {
    const h = fixture(), ops = ['first','second','third'].map(q => h.start(q));
    for (const index of order) {
      if (index === 2) {
        await h.finish(ops[index], 'third'); h.state(expected('third', [item('third')]));
      } else await h.stale(ops[index], `stale-${index}`);
    }
    h.state(expected('third', [item('third')]));
  }
});

console.log(JSON.stringify(checks));
process.exitCode = checks.every(c => c.pass) ? 0 : 1;
