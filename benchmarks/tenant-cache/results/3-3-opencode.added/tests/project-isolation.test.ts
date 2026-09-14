import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { projectService } from '../src/services/project-service.ts';
import type { ListOptions } from '../src/types.ts';

test('nonmembers cannot read, update, or list projects, including warm caches', () => {
  const cache = createCache();
  const app = createApp(sampleSeed(), cache);
  app.request({method:'GET', path:'/organizations/org-a/projects', token:'alice'});
  const projects = structuredClone(app.db.projects);
  const metrics = {...cache.metrics};
  for (const request of [
    {method:'GET', path:'/projects/a1'},
    {method:'PATCH', path:'/projects/a1', body:{name:'Stolen', organizationId:'org-b'}},
    {method:'GET', path:'/organizations/org-a/projects'},
  ]) {
    assert.deepEqual(app.request({...request, token:'bob', query:{organizationId:'org-b'}}),
      {status:403, body:{error:'forbidden'}});
  }
  assert.deepEqual(app.db.projects, projects);
  assert.equal(app.db.counters.projectUpdates, 0);
  assert.deepEqual(cache.metrics, metrics);

  app.db.memberships.delete(JSON.stringify(['alice', 'org-a']));
  for (const method of ['GET', 'PATCH']) {
    assert.deepEqual(app.request({method, path:'/projects/a1', token:'alice', body:{name:'Revoked'}}),
      {status:403, body:{error:'forbidden'}});
  }
  assert.deepEqual(app.request({method:'GET', path:'/organizations/org-a/projects', token:'alice'}),
    {status:403, body:{error:'forbidden'}});
  assert.deepEqual(app.db.projects, projects);
  assert.deepEqual(cache.metrics, metrics);
});

test('switching organizations keeps lists isolated and cached', () => {
  const app = createApp(sampleSeed());
  for (const organizationId of ['org-a', 'org-b', 'org-a', 'org-b']) {
    const result = app.request({method:'GET', path:`/organizations/${organizationId}/projects`, token:'both'});
    assert.equal(result.status, 200);
    assert.equal((result.body as any).items.length, 3);
    assert.ok((result.body as any).items.every(p => p.organizationId === organizationId));
  }
  assert.equal(app.db.counters.projectLists, 2);
});

test('updates invalidate all owning-organization variants and preserve unrelated cache hits', () => {
  const seed = sampleSeed();
  const otherId = 'org-a:1:"suffix';
  seed.organizations[1].id = otherId;
  for (const p of seed.projects) if (p.organizationId === 'org-b') p.organizationId = otherId;
  for (const m of seed.memberships) if (m.organizationId === 'org-b') m.organizationId = otherId;
  const app = createApp(seed);
  const service = projectService(app.db, app.cache);
  const variants: ListOptions[] = [];
  for (const page of [1, 2]) for (const pageSize of [1, 2]) {
    for (const sort of ['name', 'updatedAt'] as const) for (const direction of ['asc', 'desc'] as const) {
      variants.push({page, pageSize, sort, direction});
    }
  }
  const snapshots = new Map<string, unknown[]>();
  for (const id of ['org-a', otherId]) {
    snapshots.set(id, variants.map(options => service.list('both', id, options)));
  }
  assert.equal(app.db.counters.projectLists, variants.length * 2);
  assert.equal(app.cache.keys().length, variants.length * 2);
  for (const id of ['org-a', otherId]) {
    assert.deepEqual(variants.map(options => service.list('both', id, options)), snapshots.get(id));
  }
  assert.equal(app.db.counters.projectLists, variants.length * 2);

  service.update('both', 'a1', {name:'Zulu'});
  assert.equal(app.cache.keys().length, variants.length);
  assert.deepEqual(variants.map(options => service.list('both', otherId, options)), snapshots.get(otherId));
  assert.equal(app.db.counters.projectLists, variants.length * 2);

  const fresh = projectService(app.db, createCache());
  for (const options of variants) {
    assert.deepEqual(service.list('both', 'org-a', options), fresh.list('both', 'org-a', options));
  }
  assert.equal(app.db.counters.projectLists, variants.length * 4);
  const reads = app.db.counters.projectLists;
  for (const options of variants) service.list('both', 'org-a', options);
  assert.equal(app.db.counters.projectLists, reads);
});

test('missing projects and invalid updates preserve status conventions and cache entries', () => {
  const cache = createCache();
  const app = createApp(sampleSeed(), cache);
  app.request({method:'GET', path:'/organizations/org-a/projects', token:'alice'});
  const projects = structuredClone(app.db.projects);
  const metrics = {...cache.metrics};
  for (const method of ['GET', 'PATCH']) {
    assert.deepEqual(app.request({method, path:'/projects/missing', token:'alice', body:{name:'New'}}),
      {status:404, body:{error:'not_found'}});
  }
  assert.deepEqual(app.request({method:'PATCH', path:'/projects/a1', token:'alice', body:{name:' '}}),
    {status:400, body:{error:'invalid_body'}});
  assert.deepEqual(app.db.projects, projects);
  assert.deepEqual(cache.metrics, metrics);
});
