import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';

test('nonmembers cannot read, update, or list projects, even with forged ownership', () => {
  const app = createApp(sampleSeed());
  app.request({method:'GET', path:'/organizations/org-b/projects', token:'bob'});
  const stored = structuredClone(app.db.projects);
  const keys = app.cache.keys();
  for (const method of ['GET', 'PATCH']) {
    assert.deepEqual(app.request({method, path:'/projects/b1', token:'alice',
      query:{organizationId:'org-a'}, body:{name:'Stolen', organizationId:'org-a'}}),
    {status:403, body:{error:'forbidden'}});
  }
  assert.deepEqual(app.request({method:'GET', path:'/organizations/org-b/projects', token:'alice'}),
    {status:403, body:{error:'forbidden'}});
  assert.deepEqual(app.db.projects, stored);
  assert.equal(app.db.counters.projectUpdates, 0);
  assert.deepEqual(app.cache.keys(), keys);
  for (const method of ['GET', 'PATCH']) {
    assert.deepEqual(app.request({method, path:'/projects/missing', token:'alice', body:{name:'New'}}),
      {status:404, body:{error:'not_found'}});
  }
});

test('switching organizations isolates cached lists and membership revocation applies immediately', () => {
  const app = createApp(sampleSeed());
  for (const organizationId of ['org-a', 'org-b', 'org-a', 'org-b']) {
    const response = app.request({method:'GET', path:`/organizations/${organizationId}/projects`, token:'both'});
    assert.equal(response.status, 200);
    assert.ok((response.body as any).items.every((p:any) => p.organizationId === organizationId));
  }
  assert.equal(app.db.counters.projectLists, 2);
  app.db.memberships.delete(JSON.stringify(['both', 'org-a']));
  assert.deepEqual(app.request({method:'GET', path:'/organizations/org-a/projects', token:'both'}),
    {status:403, body:{error:'forbidden'}});
  assert.deepEqual(app.request({method:'GET', path:'/projects/a1', token:'both'}),
    {status:403, body:{error:'forbidden'}});
  assert.deepEqual(app.request({method:'PATCH', path:'/projects/a1', token:'both', body:{name:'Denied'}}),
    {status:403, body:{error:'forbidden'}});
  assert.equal(app.db.counters.projectUpdates, 0);
});

test('updates invalidate all owning organization variants and retain unrelated opaque IDs', () => {
  const seed = sampleSeed();
  const ids = ['org-a', 'org-a:child', 'org-a"', 'org-a":1:10:name:asc'];
  for (const id of ids.slice(1)) {
    seed.organizations.push({id, name:id});
    seed.memberships.push({userId:'both', organizationId:id});
    seed.projects.push({id:`project-${id}`, organizationId:id, name:id, updatedAt:1});
  }
  const app = createApp(seed);
  const queries:Record<string,string>[] = [];
  for (const page of ['1', '2']) for (const pageSize of ['1', '2'])
    for (const sort of ['name', 'updatedAt']) for (const direction of ['asc', 'desc'])
      queries.push({page, pageSize, sort, direction});
  const list = (id:string, query:Record<string,string>) =>
    app.request({method:'GET', path:`/organizations/${id}/projects`, token:'both', query});
  for (const id of ids) for (const query of queries) {
    const response = list(id, query);
    assert.equal(response.status, 200);
    assert.deepEqual(list(id, query), response);
  }
  assert.equal(app.db.counters.projectLists, ids.length * queries.length);
  assert.equal(app.cache.keys().length, ids.length * queries.length);
  assert.equal(app.request({method:'PATCH', path:'/projects/a1', token:'both', body:{name:' Zulu '}}).status, 200);
  assert.equal(app.cache.keys().length, (ids.length - 1) * queries.length);
  for (const id of ids.slice(1)) for (const query of queries) list(id, query);
  assert.equal(app.db.counters.projectLists, ids.length * queries.length);
  const freshSeed = sampleSeed();
  freshSeed.projects.find(p => p.id === 'a1')!.name = 'Zulu';
  freshSeed.projects.find(p => p.id === 'a1')!.updatedAt++;
  const fresh = createApp(freshSeed);
  for (const query of queries) {
    const response = list('org-a', query);
    assert.deepEqual(response, fresh.request({method:'GET', path:'/organizations/org-a/projects', token:'both', query}));
    assert.deepEqual(list('org-a', query), response);
  }
  assert.equal(app.db.counters.projectLists, (ids.length + 1) * queries.length);
});
