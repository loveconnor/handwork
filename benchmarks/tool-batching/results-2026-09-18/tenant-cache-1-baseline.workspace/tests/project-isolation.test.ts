import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { membershipRepository } from '../src/db/membership-repository.ts';
import { projectRepository } from '../src/db/project-repository.ts';
import type { ListOptions } from '../src/types.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read or update projects, spoof ownership, or use cached lists',()=>{
  const a=createApp(sampleSeed());
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const storage=structuredClone(a.db.projects);
  const entries=a.cache.keys().map(key=>[key,a.cache.get(key)]);
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
    assert.deepEqual(a.request({method,path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
  }
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-a/projects',token:'bob'}),forbidden);
  assert.deepEqual(a.db.projects,storage);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.equal(a.db.counters.projectLists,1);
  assert.deepEqual(a.cache.keys().map(key=>[key,a.cache.get(key)]),entries);
});

test('revoking membership denies cached lists and project reads and updates',()=>{
  const a=createApp(sampleSeed());
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(a.request(request).status,200);
  membershipRepository(a.db).revoke('alice','org-a');
  assert.deepEqual(a.request(request),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Denied'}}),forbidden);
  assert.equal(a.db.counters.projectLists,1);
  assert.equal(a.db.counters.projectUpdates,0);
});

test('cache isolates every list option and invalidates only the owning organization',()=>{
  const seed=sampleSeed();
  // Opaque IDs can share prefixes and contain cache separators or quotes.
  const ids=['org-a','org-a:child','org-a" :child'];
  for(const id of ids.slice(1)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`project-${id}`,organizationId:id,name:'Other',updatedAt:1});
  }
  const a=createApp(seed);
  const expected=createApp(seed);
  const variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const)variants.push({page,pageSize,sort,direction});
  const list=(id:string,options:ListOptions)=>a.request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query:Object.fromEntries(Object.entries(options).map(([k,v])=>[k,String(v)]))});
  const repository=projectRepository(expected.db);
  for(const id of ids)for(const options of variants) {
    const result=list(id,options);
    assert.deepEqual(result,{status:200,body:repository.list(id,options)});
    assert.deepEqual(list(id,options),result);
  }
  assert.equal(a.db.counters.projectLists,ids.length*variants.length);
  assert.equal(a.cache.keys().length,ids.length*variants.length);
  const keys=a.cache.keys();
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:''}}).status,400);
  assert.deepEqual(a.cache.keys(),keys);
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:ids[1]}}).status,200);
  repository.update('a1','Zulu');
  assert.equal(a.db.projects.get('a1')!.organizationId,'org-a');
  assert.equal(a.cache.keys().length,(ids.length-1)*variants.length);
  const before=a.db.counters.projectLists;
  for(const id of ids.slice(1))for(const options of variants)assert.deepEqual(list(id,options),{status:200,body:repository.list(id,options)});
  assert.equal(a.db.counters.projectLists,before);
  for(const options of variants) {
    const result=list('org-a',options);
    assert.deepEqual(result,{status:200,body:repository.list('org-a',options)});
    assert.deepEqual(list('org-a',options),result);
  }
  assert.equal(a.db.counters.projectLists,before+variants.length);
});
