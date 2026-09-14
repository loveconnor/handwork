import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { membershipRepository } from '../src/db/membership-repository.ts';
import { projectListKey } from '../src/cache/keys.ts';
import type { ListOptions } from '../src/types.ts';

test('cross-organization requests are forbidden and cannot mutate storage or cache',()=>{
  const app=createApp(sampleSeed());
  app.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const projects=structuredClone(app.db.projects);
  const entries=app.cache.keys().map(key=>[key,app.cache.get(key)]);
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(app.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),{status:403,body:{error:'forbidden'}});
    assert.deepEqual(app.request({method,path:'/projects/missing',token:'alice',body:{name:'New'}}),{status:404,body:{error:'not_found'}});
  }
  assert.deepEqual(app.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),{status:403,body:{error:'forbidden'}});
  assert.deepEqual(app.db.projects,projects);
  assert.equal(app.db.counters.projectUpdates,0);
  assert.deepEqual(app.cache.keys().map(key=>[key,app.cache.get(key)]),entries);
});

test('cached lists remain organization-scoped and membership revocation takes effect immediately',()=>{
  const app=createApp(sampleSeed());
  for(const organizationId of ['org-a','org-b','org-a','org-b']) {
    const response=app.request({method:'GET',path:`/organizations/${organizationId}/projects`,token:'both'});
    assert.equal(response.status,200);
    assert.ok((response.body as any).items.every((p:any)=>p.organizationId===organizationId));
  }
  assert.equal(app.db.counters.projectLists,2);
  membershipRepository(app.db).revoke('both','org-a');
  for(const request of [
    {method:'GET',path:'/organizations/org-a/projects'},
    {method:'GET',path:'/projects/a1'},
    {method:'PATCH',path:'/projects/a1',body:{name:'Denied'}},
  ])assert.deepEqual(app.request({...request,token:'both'}),{status:403,body:{error:'forbidden'}});
  assert.equal(app.db.counters.projectUpdates,0);
});

test('updates invalidate all owning-organization variants while preserving unrelated cache hits',()=>{
  const seed=sampleSeed();
  // Shared prefixes and escaped delimiters must not broaden invalidation.
  const ids=['org-a','org-a:child','org-a%3Achild'];
  for(const id of ids.slice(1)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id,organizationId:id,name:id,updatedAt:1});
  }
  const app=createApp(seed);
  const variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const)variants.push({page,pageSize,sort,direction});
  const list=(id:string,options:ListOptions)=>app.request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query:{page:String(options.page),pageSize:String(options.pageSize),sort:options.sort,direction:options.direction}});
  const snapshots=new Map<string,unknown>();
  for(const id of ids)for(const options of variants) {
    const response=list(id,options);
    assert.equal(response.status,200);
    snapshots.set(projectListKey(id,options),response);
    assert.deepEqual(list(id,options),response);
  }
  assert.equal(app.db.counters.projectLists,ids.length*variants.length);
  assert.equal(app.cache.keys().length,ids.length*variants.length);
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:'org-b'}}).status,200);
  for(const options of variants)assert.equal(app.cache.get(projectListKey('org-a',options)),undefined);
  for(const id of ids.slice(1))for(const options of variants)assert.deepEqual(list(id,options),snapshots.get(projectListKey(id,options)));
  assert.equal(app.db.counters.projectLists,ids.length*variants.length);
  const fresh=createApp({...seed,projects:[...app.db.projects.values()]});
  for(const options of variants) {
    const expected=fresh.request({method:'GET',path:'/organizations/org-a/projects',token:'both',query:{page:String(options.page),pageSize:String(options.pageSize),sort:options.sort,direction:options.direction}});
    assert.deepEqual(list('org-a',options),expected);
    assert.deepEqual(list('org-a',options),expected);
  }
  assert.equal(app.db.counters.projectLists,(ids.length+1)*variants.length);
});
