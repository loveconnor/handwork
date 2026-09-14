import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { sampleSeed } from '../src/seed.ts';

const forbidden = { status: 403, body: { error: 'forbidden' } };

test('nonmembers cannot read or update projects, even with spoofed ownership', () => {
  const cache = createCache();
  const app = createApp(sampleSeed(), cache);
  app.request({ method: 'GET', path: '/organizations/org-b/projects', token: 'bob' });
  const stored = structuredClone(app.db.projects);
  const metrics = { ...cache.metrics };
  const keys = cache.keys();
  assert.deepEqual(app.request({ method: 'GET', path: '/projects/b1', token: 'alice', query: { organizationId: 'org-a' } }), forbidden);
  for (const body of [{ name: 'Stolen', organizationId: 'org-a' }, { name: '' }]) {
    assert.deepEqual(app.request({ method: 'PATCH', path: '/projects/b1', token: 'alice', body }), forbidden);
  }
  assert.deepEqual(app.request({ method: 'GET', path: '/organizations/org-b/projects', token: 'alice' }), forbidden);
  assert.deepEqual(app.db.projects, stored);
  assert.equal(app.db.counters.projectUpdates, 0);
  assert.deepEqual(cache.metrics, metrics);
  assert.deepEqual(cache.keys(), keys);
  assert.deepEqual(app.request({ method: 'GET', path: '/projects/missing', token: 'alice' }), { status: 404, body: { error: 'not_found' } });
});

test('revoked membership is checked before cached lists and project access', () => {
  const app = createApp(sampleSeed());
  const request = { method: 'GET', path: '/organizations/org-a/projects', token: 'alice' };
  assert.equal(app.request(request).status, 200);
  app.db.memberships.delete(JSON.stringify(['alice', 'org-a']));
  assert.deepEqual(app.request(request), forbidden);
  assert.deepEqual(app.request({ method: 'GET', path: '/projects/a1', token: 'alice' }), forbidden);
  assert.deepEqual(app.request({ method: 'PATCH', path: '/projects/a1', token: 'alice', body: { name: 'Denied' } }), forbidden);
  assert.equal(app.db.counters.projectLists, 1);
  assert.equal(app.db.counters.projectUpdates, 0);
});

test('all list variants are isolated and only the updated organization is invalidated', () => {
  const seed = sampleSeed();
  const organizations = ['org-a', 'org-a:child', 'org-a"', 'org-a\\'];
  for (const id of organizations.slice(1)) {
    seed.organizations.push({ id, name: id });
    seed.memberships.push({ userId: 'both', organizationId: id });
    seed.projects.push({ id: `${id}-project`, organizationId: id, name: id, updatedAt: 1 });
  }
  const app = createApp(seed);
  const variants: Record<string, string>[] = [];
  for (const page of ['1', '2']) for (const pageSize of ['1', '2'])
    for (const sort of ['name', 'updatedAt']) for (const direction of ['asc', 'desc'])
      variants.push({ page, pageSize, sort, direction });
  const list = (organizationId: string, query: Record<string, string>) =>
    app.request({ method: 'GET', path: `/organizations/${organizationId}/projects`, token: 'both', query });
  const snapshots = new Map<string, unknown>();
  for (const id of organizations) for (const query of variants) {
    const response = list(id, query);
    assert.equal(response.status, 200);
    const body = response.body as any;
    assert.ok(body.items.every((p: any) => p.organizationId === id));
    assert.equal(body.page, Number(query.page));
    assert.equal(body.pageSize, Number(query.pageSize));
    assert.equal(body.sort, query.sort);
    assert.equal(body.direction, query.direction);
    snapshots.set(JSON.stringify([id, query]), response);
  }
  assert.equal(app.db.counters.projectLists, organizations.length * variants.length);
  for (const id of organizations) for (const query of variants)
    assert.deepEqual(list(id, query), snapshots.get(JSON.stringify([id, query])));
  assert.equal(app.db.counters.projectLists, organizations.length * variants.length);

  assert.equal(app.request({ method: 'PATCH', path: '/projects/a1', token: 'both', body: { name: 'Zulu' } }).status, 200);
  const before = app.db.counters.projectLists;
  for (const id of organizations.slice(1)) for (const query of variants)
    assert.deepEqual(list(id, query), snapshots.get(JSON.stringify([id, query])));
  assert.equal(app.db.counters.projectLists, before);
  const freshSeed = sampleSeed();
  freshSeed.projects = [...app.db.projects.values()];
  const fresh = createApp(freshSeed);
  for (const query of variants) {
    assert.deepEqual(list('org-a', query), fresh.request({ method: 'GET', path: '/organizations/org-a/projects', token: 'both', query }));
  }
  assert.equal(app.db.counters.projectLists, before + variants.length);
  for (const query of variants) list('org-a', query);
  assert.equal(app.db.counters.projectLists, before + variants.length);
});
