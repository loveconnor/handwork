import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { projectService } from '../src/services/project-service.ts';
import type { ListOptions, Project } from '../src/types.ts';

test('unauthorized reads, updates, and cached lists are forbidden without mutations',()=>{
  const app=createApp(sampleSeed());
  app.request({method:'GET',path:'/organizations/org-a/projects',token:'alice'});
  const before=structuredClone(app.db.projects);
  const keys=app.cache.keys();
  const forbidden={status:403,body:{error:'forbidden'}};
  assert.deepEqual(app.request({method:'GET',path:'/projects/a1',token:'bob',query:{organizationId:'org-b'}}),forbidden);
  assert.deepEqual(app.request({method:'PATCH',path:'/projects/a1',token:'bob',body:{name:'Stolen',organizationId:'org-b'}}),forbidden);
  assert.deepEqual(app.request({method:'GET',path:'/organizations/org-a/projects',token:'bob'}),forbidden);
  app.db.memberships.delete(JSON.stringify(['alice','org-a']));
  assert.deepEqual(app.request({method:'GET',path:'/organizations/org-a/projects',token:'alice'}),forbidden);
  assert.deepEqual(app.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(app.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Revoked'}}),forbidden);
  assert.deepEqual(app.db.projects,before);
  assert.equal(app.db.counters.projectUpdates,0);
  assert.deepEqual(app.cache.keys(),keys);
});

test('switching organizations isolates cached lists and retains cache hits',()=>{
  const app=createApp(sampleSeed());
  for(const organizationId of ['org-a','org-b','org-a','org-b']) {
    const response=app.request({method:'GET',path:`/organizations/${organizationId}/projects`,token:'both'});
    assert.equal(response.status,200);
    assert.ok((response.body as {items:Project[]}).items.every(p=>p.organizationId===organizationId));
  }
  assert.equal(app.db.counters.projectLists,2);
});

test('updates invalidate all owning-organization variants, preserving other cache hits',()=>{
  const seed=sampleSeed();
  const other='org-a:child"';
  seed.organizations.push({id:other,name:'Other'});
  seed.memberships.push({userId:'both',organizationId:other});
  seed.projects.push({id:'other',organizationId:other,name:'Other',updatedAt:1});
  const app=createApp(seed);
  const service=projectService(app.db,app.cache);
  const variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const) {
    variants.push({page,pageSize,sort,direction});
  }
  for(const org of ['org-a','org-b',other])for(const options of variants)service.list('both',org,options);
  assert.equal(app.cache.keys().length,variants.length*3);
  const unaffected=app.cache.keys().slice(variants.length);
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:'org-b'}}).status,200);
  assert.deepEqual(app.cache.keys(),unaffected);
  const reads=app.db.counters.projectLists;
  for(const org of ['org-b',other])for(const options of variants)service.list('both',org,options);
  assert.equal(app.db.counters.projectLists,reads);
  const fresh=createApp({...seed,projects:[...app.db.projects.values()]});
  const freshService=projectService(fresh.db,fresh.cache);
  for(const options of variants)assert.deepEqual(service.list('both','org-a',options),freshService.list('both','org-a',options));
  assert.equal(app.db.counters.projectLists,reads+variants.length);
  for(const options of variants)service.list('both','org-a',options);
  assert.equal(app.db.counters.projectLists,reads+variants.length);
});
