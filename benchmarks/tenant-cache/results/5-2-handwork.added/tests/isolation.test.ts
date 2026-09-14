import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { projectRepository } from '../src/db/project-repository.ts';
import type { ListOptions } from '../src/types.ts';

const forbidden={status:403,body:{error:'forbidden'}};
test('owning membership gates reads and writes without storage or cache mutations',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const stored=structuredClone([...a.db.projects]),keys=cache.keys(),metrics={...cache.metrics};
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  }
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual([...a.db.projects],stored);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('organization switches, all list variants, and selective invalidation with opaque IDs',()=>{
  const seed=sampleSeed();
  const ids=['org-a','org-a:child','org-a"\\:child'];
  for(const id of ids.slice(1)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`project-${id}`,organizationId:id,name:'Other',updatedAt:1});
  }
  const a=createApp(seed),variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const)variants.push({page,pageSize,sort,direction});
  const list=(id:string,options:ListOptions)=>a.request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query:Object.fromEntries(Object.entries(options).map(([k,v])=>[k,String(v)]))});
  const expected=createApp(seed);
  const repository=projectRepository(expected.db);
  for(const id of ids)for(const options of variants) {
    const response=list(id,options);
    assert.deepEqual(response,{status:200,body:repository.list(id,options)});
    const count=a.db.counters.projectLists;
    assert.deepEqual(list(id,options),response);
    assert.equal(a.db.counters.projectLists,count);
  }
  const count=a.db.counters.projectLists;
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:ids[1]}}).status,200);
  repository.update('a1','Zulu');
  assert.equal(a.db.projects.get('a1')!.organizationId,'org-a');
  for(const id of ids.slice(1))for(const options of variants)assert.deepEqual(list(id,options).body,repository.list(id,options));
  assert.equal(a.db.counters.projectLists,count);
  for(const options of variants)assert.deepEqual(list('org-a',options).body,repository.list('org-a',options));
  assert.equal(a.db.counters.projectLists,count+variants.length);
});

test('revocation is checked before cache access and project updates',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(a.request(request).status,200);
  a.db.memberships.delete(JSON.stringify(['alice','org-a']));
  const metrics={...cache.metrics},stored=structuredClone([...a.db.projects]);
  assert.deepEqual(a.request(request),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Denied'}}),forbidden);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual([...a.db.projects],stored);
  assert.equal(a.db.counters.projectUpdates,0);
  const count=a.db.counters.projectLists;
  assert.equal(a.request({...request,token:'both'}).status,200);
  assert.equal(a.db.counters.projectLists,count);
});
