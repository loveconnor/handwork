import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { projectListKey, projectListPrefix } from '../src/cache/keys.ts';

test('nonmembers cannot read, update, or list projects',()=>{
  const app=createApp(sampleSeed());
  const before=structuredClone(app.db.projects);
  for(const token of ['alice','both']) {
    if(token==='both')app.db.memberships.delete(JSON.stringify(['both','org-b']));
    for(const request of [
      {method:'GET',path:'/projects/b1'},
      {method:'PATCH',path:'/projects/b1',body:{name:'Stolen'}},
      {method:'GET',path:'/organizations/org-b/projects'},
    ])assert.deepEqual(app.request({...request,token}),{status:403,body:{error:'forbidden'}});
  }
  assert.deepEqual(app.db.projects,before);
  assert.equal(app.db.counters.projectUpdates,0);
});

test('organization switching isolates cached lists and cached results recheck membership',()=>{
  const app=createApp(sampleSeed());
  for(const organizationId of ['org-a','org-b','org-a','org-b']) {
    const result=app.request({method:'GET',path:`/organizations/${organizationId}/projects`,token:'both'});
    assert.equal(result.status,200);
    assert.equal((result.body as any).total,3);
    assert.ok((result.body as any).items.every((p:any)=>p.organizationId===organizationId));
  }
  assert.equal(app.db.counters.projectLists,2);
  app.db.memberships.delete(JSON.stringify(['both','org-a']));
  assert.deepEqual(app.request({method:'GET',path:'/organizations/org-a/projects',token:'both'}),{status:403,body:{error:'forbidden'}});
  assert.equal(app.db.counters.projectLists,2);
});

test('updates invalidate every affected list variant and retain other organizations cache',()=>{
  const app=createApp(sampleSeed());
  const queries=[];
  for(const page of ['1','2'])for(const pageSize of ['1','2'])
    for(const sort of ['name','updatedAt'])for(const direction of ['asc','desc'])
      queries.push({page,pageSize,sort,direction});
  const list=(organizationId:string,query:typeof queries[number])=>app.request({method:'GET',path:`/organizations/${organizationId}/projects`,token:'both',query});
  const other=queries.map(query=>list('org-b',query));
  for(const query of queries)assert.equal(list('org-a',query).status,200);
  assert.equal(app.cache.keys().length,queries.length*2);
  const before=app.db.counters.projectLists;
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Zulu'}}).status,200);
  assert.equal(app.cache.keys().length,queries.length);
  queries.forEach((query,index)=>assert.deepEqual(list('org-b',query),other[index]));
  assert.equal(app.db.counters.projectLists,before);
  const seed=sampleSeed();
  seed.projects[0]={...seed.projects[0],name:'Zulu',updatedAt:4};
  const fresh=createApp(seed);
  for(const query of queries)assert.deepEqual(list('org-a',query),fresh.request({method:'GET',path:'/organizations/org-a/projects',token:'alice',query}));
  assert.equal(app.db.counters.projectLists,before+queries.length);
  for(const query of queries)list('org-a',query);
  assert.equal(app.db.counters.projectLists,before+queries.length);
});

test('organization prefixes cannot overlap at delimiters',()=>{
  const options={page:1,pageSize:10,sort:'name',direction:'asc'} as const;
  for(const organizationId of ['org-a-extra','org-a:child','org-a%3Achild']) {
    assert.ok(!projectListKey(organizationId,options).startsWith(projectListPrefix('org-a')));
  }
});
