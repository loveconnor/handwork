import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { projectListKey, projectListPrefix } from '../src/cache/keys.ts';
import { sampleSeed } from '../src/seed.ts';
import type { ListOptions } from '../src/types.ts';

const forbidden = {status:403,body:{error:'forbidden'}};

test('foreign project reads and updates are forbidden without changing storage or cache', () => {
  const cache=createCache(), app=createApp(sampleSeed(),cache);
  app.request({method:'GET',path:'/organizations/org-a/projects',token:'alice'});
  const before=structuredClone(app.db.projects), keys=cache.keys(), metrics={...cache.metrics};
  assert.deepEqual(app.request({method:'GET',path:'/projects/a1',token:'bob'}),forbidden);
  for(const body of [{name:'Stolen'},{name:''}]) {
    assert.deepEqual(app.request({method:'PATCH',path:'/projects/a1',token:'bob',body}),forbidden);
  }
  assert.deepEqual(app.db.projects,before);
  assert.equal(app.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(app.request({method,path:'/projects/missing',token:'alice',body:{name:'New'}}),{status:404,body:{error:'not_found'}});
  }
});

test('list authorization is checked before both cache misses and cache hits', () => {
  const cache=createCache(), app=createApp(sampleSeed(),cache);
  const request={method:'GET',path:'/organizations/org-a/projects'};
  assert.deepEqual(app.request({...request,token:'bob'}),forbidden);
  assert.equal(app.db.counters.projectLists,0);
  assert.equal(app.request({...request,token:'alice'}).status,200);
  const metrics={...cache.metrics};
  assert.deepEqual(app.request({...request,token:'bob'}),forbidden);
  app.db.memberships.delete(JSON.stringify(['alice','org-a']));
  assert.deepEqual(app.request({...request,token:'alice'}),forbidden);
  assert.deepEqual(cache.metrics,metrics);
  assert.equal(app.db.counters.projectLists,1);
});

test('organization switching isolates lists and updates invalidate every affected variant only', () => {
  const cache=createCache(), app=createApp(sampleSeed(),cache);
  const variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const) {
    variants.push({page,pageSize,sort,direction});
  }
  const list=(organizationId:string,options:ListOptions)=>app.request({
    method:'GET',path:`/organizations/${organizationId}/projects`,token:'both',
    query:Object.fromEntries(Object.entries(options).map(([key,value])=>[key,String(value)])),
  });
  const fresh=createApp(sampleSeed());
  for(const options of variants)for(const org of ['org-a','org-b']) {
    const result=list(org,options);
    const expected=fresh.request({method:'GET',path:`/organizations/${org}/projects`,token:'both',query:Object.fromEntries(Object.entries(options).map(([key,value])=>[key,String(value)]))});
    assert.deepEqual(result,expected);
    assert.deepEqual(list(org,options),result);
  }
  assert.equal(app.db.counters.projectLists,variants.length*2);
  assert.equal(cache.keys().length,variants.length*2);
  const bResults=variants.map(options=>list('org-b',options));
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:' Zulu '}}).status,200);
  assert.equal(cache.keys().length,variants.length);
  const reads=app.db.counters.projectLists;
  variants.forEach((options,index)=>assert.deepEqual(list('org-b',options),bResults[index]));
  assert.equal(app.db.counters.projectLists,reads);
  fresh.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Zulu'}});
  for(const options of variants) {
    const expected=fresh.request({method:'GET',path:'/organizations/org-a/projects',token:'alice',query:Object.fromEntries(Object.entries(options).map(([key,value])=>[key,String(value)]))});
    assert.deepEqual(list('org-a',options),expected);
    assert.deepEqual(list('org-a',options),expected);
  }
  assert.equal(app.db.counters.projectLists,reads+variants.length);
});

test('organization key boundaries cannot collide with delimiter-containing identifiers', () => {
  const options:ListOptions={page:1,pageSize:10,sort:'name',direction:'asc'};
  const ids=['org','org:child','org%3Achild'];
  assert.equal(new Set(ids.map(id=>projectListKey(id,options))).size,ids.length);
  for(const id of ids)for(const other of ids) {
    assert.equal(projectListKey(other,options).startsWith(projectListPrefix(id)),id===other);
  }
});
