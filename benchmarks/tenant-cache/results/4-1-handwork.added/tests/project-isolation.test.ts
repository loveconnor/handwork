import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { projectListKey, projectListPrefix } from '../src/cache/keys.ts';
import type { ListOptions } from '../src/types.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('owning organization controls detail and updates without unauthorized mutations',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const projects=structuredClone(a.db.projects),keys=cache.keys(),metrics={...cache.metrics};
  for(const method of ['GET','PATCH'])assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual(a.db.projects,projects);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('organization switching isolates all list variants and updates invalidate only the owner',()=>{
  const a=createApp(sampleSeed());
  const variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const)variants.push({page,pageSize,sort,direction});
  const list=(org:string,options:ListOptions)=>a.request({method:'GET',path:`/organizations/${org}/projects`,token:'both',query:Object.fromEntries(Object.entries(options).map(([k,v])=>[k,String(v)]))});
  const beforeB=variants.map(options=>{
    for(const org of ['org-a','org-b']){
      const response=list(org,options);
      assert.equal(response.status,200);
      const body=response.body as any;
      assert.equal(body.total,3);
      for(const [key,value] of Object.entries(options))assert.equal(body[key],value);
      assert.ok(body.items.every((p:any)=>p.organizationId===org));
      assert.deepEqual(list(org,options),response);
    }
    return list('org-b',options);
  });
  assert.equal(a.db.counters.projectLists,variants.length*2);
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:'org-b'}}).status,200);
  assert.equal(a.db.projects.get('a1')!.organizationId,'org-a');
  assert.ok(a.cache.keys().every(key=>!key.startsWith(projectListPrefix('org-a'))));
  variants.forEach((options,i)=>assert.deepEqual(list('org-b',options),beforeB[i]));
  assert.equal(a.db.counters.projectLists,variants.length*2);
  const fresh=createApp({...sampleSeed(),projects:[...a.db.projects.values()]});
  for(const options of variants){
    const query=Object.fromEntries(Object.entries(options).map(([k,v])=>[k,String(v)]));
    assert.deepEqual(list('org-a',options),fresh.request({method:'GET',path:'/organizations/org-a/projects',token:'both',query}));
  }
  assert.equal(a.db.counters.projectLists,variants.length*3);
});

test('revoked membership is checked before cache access and updates',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(a.request(request).status,200);
  a.db.memberships.delete(JSON.stringify(['alice','org-a']));
  const metrics={...cache.metrics};
  assert.deepEqual(a.request(request),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Denied'}}),forbidden);
  assert.deepEqual(cache.metrics,metrics);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.equal(a.db.counters.projectLists,1);
});

test('opaque organization IDs cannot overlap cache invalidation prefixes',()=>{
  const seed=sampleSeed();
  const ids=['org-a','org-a:child','org-a"', 'org-a\\', 'org-a:1:10:name:asc'];
  seed.organizations=ids.map(id=>({id,name:id}));
  seed.memberships=ids.map(organizationId=>({userId:'both',organizationId}));
  seed.projects=ids.map((organizationId,i)=>({id:`p${i}`,organizationId,name:'Old',updatedAt:1}));
  const a=createApp(seed),options:ListOptions={page:1,pageSize:10,sort:'name',direction:'asc'};
  // Seed through the public cache interface to exercise punctuation without URL routing constraints.
  for(const id of ids)a.cache.set(projectListKey(id,options),{organizationId:id});
  assert.equal(new Set(ids.map(id=>projectListKey(id,options))).size,ids.length);
  for(let i=0;i<ids.length;i++){
    assert.equal(a.request({method:'PATCH',path:`/projects/p${i}`,token:'both',body:{name:'New'}}).status,200);
    assert.equal(a.cache.get(projectListKey(ids[i],options)),undefined);
    for(const id of ids.slice(i+1))assert.deepEqual(a.cache.get(projectListKey(id,options)),{organizationId:id});
  }
});
