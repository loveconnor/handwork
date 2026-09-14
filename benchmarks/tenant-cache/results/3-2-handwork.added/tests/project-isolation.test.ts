import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read, update, or list projects, even with spoofed ownership',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const projects=structuredClone(a.db.projects),keys=cache.keys(),metrics={...cache.metrics};
  assert.deepEqual(a.request({method:'GET',path:'/projects/b1',token:'alice',query:{organizationId:'org-a'}}),forbidden);
  for(const body of [{name:'Stolen',organizationId:'org-a'},{name:''}]) {
    assert.deepEqual(a.request({method:'PATCH',path:'/projects/b1',token:'alice',body}),forbidden);
  }
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual(a.db.projects,projects);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('organization switching isolates lists and revocation is checked before cache access',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  for(const organizationId of ['org-a','org-b','org-a','org-b']) {
    const r=a.request({method:'GET',path:`/organizations/${organizationId}/projects`,token:'both'});
    assert.equal(r.status,200);
    assert.ok((r.body as any).items.every((p:any)=>p.organizationId===organizationId));
  }
  assert.equal(a.db.counters.projectLists,2);
  assert.equal(cache.metrics.hits,2);
  a.db.memberships.delete(JSON.stringify(['both','org-a']));
  const metrics={...cache.metrics};
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-a/projects',token:'both'}),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'both'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Denied'}}),forbidden);
  assert.deepEqual(cache.metrics,metrics);
  assert.equal(a.db.counters.projectUpdates,0);
});

test('updates invalidate every owning-organization variant without evicting overlapping opaque IDs',()=>{
  const seed=sampleSeed();
  const ids=['org-a','org-a:child','org-a"','org-a\\'];
  for(const id of ids.slice(1)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`p-${id}`,organizationId:id,name:'Other',updatedAt:1});
  }
  const cache=createCache(),a=createApp(seed,cache);
  const queries:Record<string,string>[]=[];
  for(const page of ['1','2'])for(const pageSize of ['1','2'])for(const sort of ['name','updatedAt'])for(const direction of ['asc','desc'])queries.push({page,pageSize,sort,direction});
  const list=(id:string,query:Record<string,string>)=>a.request({method:'GET',path:`/organizations/${id}/projects`,token:'both',query});
  for(const id of ids)for(const query of queries) {
    const r=list(id,query);
    assert.equal(r.status,200);
    assert.deepEqual(list(id,query),r);
  }
  assert.equal(a.db.counters.projectLists,ids.length*queries.length);
  assert.equal(cache.keys().length,ids.length*queries.length);
  const unrelated=cache.keys().slice(queries.length);
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:ids[1]}}).status,200);
  assert.deepEqual(cache.keys(),unrelated);
  const reads=a.db.counters.projectLists;
  for(const id of ids.slice(1))for(const query of queries)assert.equal(list(id,query).status,200);
  assert.equal(a.db.counters.projectLists,reads);
  const fresh=createApp({...seed,projects:[...a.db.projects.values()]});
  for(const query of queries) {
    assert.deepEqual(list('org-a',query),fresh.request({method:'GET',path:'/organizations/org-a/projects',token:'both',query}));
  }
  assert.equal(a.db.counters.projectLists,reads+queries.length);
  for(const query of queries)list('org-a',query);
  assert.equal(a.db.counters.projectLists,reads+queries.length);
});
