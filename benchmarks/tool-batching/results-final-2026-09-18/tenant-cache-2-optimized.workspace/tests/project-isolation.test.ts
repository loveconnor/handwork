import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { projectRepository } from '../src/db/project-repository.ts';
import type { ListOptions } from '../src/types.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read or update projects, even with spoofed ownership',()=>{
  const cache=createCache(), app=createApp(sampleSeed(),cache);
  app.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const stored=structuredClone(app.db.projects), metrics={...cache.metrics};
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(app.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  }
  assert.deepEqual(app.db.projects,stored);
  assert.equal(app.db.counters.projectUpdates,0);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual(app.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('list authorization precedes cache access and revoked membership takes effect',()=>{
  const cache=createCache(), app=createApp(sampleSeed(),cache);
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.deepEqual(app.request({...request,token:'bob'}),forbidden);
  assert.equal(cache.metrics.misses,0);
  assert.equal(app.request(request).status,200);
  assert.equal(app.request(request).status,200);
  assert.equal(app.db.counters.projectLists,1);
  const metrics={...cache.metrics};
  app.db.memberships.delete(JSON.stringify(['alice','org-a']));
  assert.deepEqual(app.request(request),forbidden);
  assert.deepEqual(app.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(app.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Denied'}}),forbidden);
  assert.deepEqual(cache.metrics,metrics);
  assert.equal(app.db.counters.projectUpdates,0);
});

test('all list variants are isolated and only the updated organization is invalidated',()=>{
  const seed=sampleSeed();
  const organizations=['org-a','org-a:child','org-a" : / \\'];
  for(const [index,id] of organizations.entries()) {
    if(index===0)continue;
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`extra-${index}`,organizationId:id,name:'Other',updatedAt:1});
  }
  organizations.push('org-b');
  const app=createApp(seed), expected=createApp(seed);
  const variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const)variants.push({page,pageSize,sort,direction});
  function list(organizationId:string,options:ListOptions) {
    return app.request({method:'GET',path:`/organizations/${encodeURIComponent(organizationId)}/projects`,token:'both',query:Object.fromEntries(Object.entries(options).map(([key,value])=>[key,String(value)]))});
  }
  for(const id of organizations)for(const options of variants) {
    const result={status:200,body:projectRepository(expected.db).list(id,options)};
    assert.deepEqual(list(id,options),result);
    assert.deepEqual(list(id,options),result);
  }
  const queries=organizations.length*variants.length;
  assert.equal(app.db.counters.projectLists,queries);
  const keys=app.cache.keys();
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:''}}).status,400);
  assert.deepEqual(app.cache.keys(),keys);
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:'org-b'}}).status,200);
  projectRepository(expected.db).update('a1','Zulu');
  assert.equal(app.db.projects.get('a1')!.organizationId,'org-a');
  for(const id of organizations.slice(1))for(const options of variants)assert.deepEqual(list(id,options),{status:200,body:projectRepository(expected.db).list(id,options)});
  assert.equal(app.db.counters.projectLists,queries);
  for(const options of variants) {
    const result={status:200,body:projectRepository(expected.db).list('org-a',options)};
    assert.deepEqual(list('org-a',options),result);
    assert.deepEqual(list('org-a',options),result);
  }
  assert.equal(app.db.counters.projectLists,queries+variants.length);
});
