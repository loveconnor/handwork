import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read or update projects, including with spoofed ownership',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const stored=structuredClone(a.db.projects),keys=cache.keys(),metrics={...cache.metrics};
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  }
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual(a.db.projects,stored);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('cached lists still require current membership',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(a.request(request).status,200);
  assert.equal(a.request(request).status,200);
  assert.equal(a.db.counters.projectLists,1);
  a.db.memberships.delete(JSON.stringify(['alice','org-a']));
  const metrics={...cache.metrics};
  assert.deepEqual(a.request(request),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Denied'}}),forbidden);
  assert.deepEqual(cache.metrics,metrics);
  assert.equal(a.db.counters.projectUpdates,0);
});

test('organization and option variants stay distinct; updates invalidate only the owning organization',()=>{
  const seed=sampleSeed();
  // Prefixes and punctuation must not cause another organization's eviction.
  const ids=['org-a','org-a:child','org-a"','org-a\\','org-b'];
  for(const id of ids.slice(1,-1)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`${id}-project`,organizationId:id,name:id,updatedAt:1});
  }
  const a=createApp(seed);
  const variants:Record<string,string>[]=[];
  for(const page of ['1','2'])for(const pageSize of ['1','2'])for(const sort of ['name','updatedAt'])for(const direction of ['asc','desc'])variants.push({page,pageSize,sort,direction});
  const list=(id:string,query:Record<string,string>)=>a.request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query});
  const expected=(id:string,query:Record<string,string>)=>createApp({...seed,projects:[...a.db.projects.values()]}).request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query});
  for(const id of ids)for(const query of variants) {
    assert.deepEqual(list(id,query),expected(id,query));
    const count=a.db.counters.projectLists;
    assert.deepEqual(list(id,query),expected(id,query));
    assert.equal(a.db.counters.projectLists,count);
  }
  assert.equal(a.cache.keys().length,ids.length*variants.length);
  const before=a.db.counters.projectLists;
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:'org-b'}}).status,200);
  assert.equal(a.db.projects.get('a1')!.organizationId,'org-a');
  assert.equal(a.cache.keys().length,(ids.length-1)*variants.length);
  for(const id of ids.slice(1))for(const query of variants)assert.deepEqual(list(id,query),expected(id,query));
  assert.equal(a.db.counters.projectLists,before);
  for(const query of variants)assert.deepEqual(list('org-a',query),expected('org-a',query));
  assert.equal(a.db.counters.projectLists,before+variants.length);
});
