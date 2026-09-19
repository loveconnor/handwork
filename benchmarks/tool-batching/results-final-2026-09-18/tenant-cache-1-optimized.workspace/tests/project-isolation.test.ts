import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { projectRepository } from '../src/db/project-repository.ts';
import type { ListOptions } from '../src/types.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read or update projects, even with spoofed ownership',()=>{
  const a=createApp(sampleSeed());
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const before=structuredClone([...a.db.projects]);
  const keys=a.cache.keys();
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
    assert.equal(a.request({method,path:'/projects/missing',token:'alice',body:{name:'New'}}).status,404);
  }
  assert.deepEqual([...a.db.projects],before);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(a.cache.keys(),keys);
});

test('list authorization applies before cache access and after membership revocation',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.deepEqual(a.request({...request,token:'bob'}),forbidden);
  assert.equal(a.db.counters.projectLists,0);
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

test('all list variants are isolated and only the updated organization is invalidated',()=>{
  const seed=sampleSeed();
  const ids=['org-a','org-a:child','org-a"\\:child'];
  for(const id of ids.slice(1)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`${id}-project`,organizationId:id,name:'Other',updatedAt:1});
  }
  ids.push('org-b');
  const a=createApp(seed);
  const variants:ListOptions[]=[];
  for(const page of [1,2]) for(const pageSize of [1,2])
    for(const sort of ['name','updatedAt'] as const) for(const direction of ['asc','desc'] as const)
      variants.push({page,pageSize,sort,direction});
  const list=(id:string,options:ListOptions)=>a.request({method:'GET',path:`/organizations/${id}/projects`,token:'both',query:Object.fromEntries(Object.entries(options).map(([k,v])=>[k,String(v)]))});
  const expected=(id:string,options:ListOptions)=>projectRepository(createApp(seed).db).list(id,options);
  for(const id of ids) for(const options of variants) {
    const response=list(id,options);
    assert.deepEqual(response,{status:200,body:expected(id,options)});
    assert.deepEqual(list(id,options),response);
  }
  assert.equal(a.db.counters.projectLists,ids.length*variants.length);
  assert.equal(a.cache.keys().length,ids.length*variants.length);
  const unrelated=a.cache.keys().filter(key=>!key.startsWith('projects:list:"org-a":'));
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:'org-b'}}).status,200);
  assert.equal(a.db.projects.get('a1')!.organizationId,'org-a');
  assert.deepEqual(a.cache.keys(),unrelated);
  const queries=a.db.counters.projectLists;
  for(const id of ids.slice(1)) for(const options of variants) assert.deepEqual(list(id,options).body,expected(id,options));
  assert.equal(a.db.counters.projectLists,queries);
  seed.projects=[...a.db.projects.values()];
  for(const options of variants) {
    assert.deepEqual(list('org-a',options).body,expected('org-a',options));
    assert.deepEqual(list('org-a',options).body,expected('org-a',options));
  }
  assert.equal(a.db.counters.projectLists,queries+variants.length);
});
