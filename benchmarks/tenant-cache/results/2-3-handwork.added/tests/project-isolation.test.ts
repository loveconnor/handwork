import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';

const forbidden={status:403,body:{error:'forbidden'}};
test('nonmembers cannot read or update projects, including with spoofed ownership',()=>{
  const a=createApp(sampleSeed());
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const entries=a.cache.keys().map(key=>[key,a.cache.get(key)]);
  const projects=[...a.db.projects];
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  }
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual([...a.db.projects],projects);
  assert.deepEqual(a.cache.keys().map(key=>[key,a.cache.get(key)]),entries);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('organization and option variants stay cached independently and updates invalidate only their owner',()=>{
  const seed=sampleSeed();
  const ids=['org-a','org-a:child','org-a"\\:child'];
  for(const id of ids.slice(1)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id,organizationId:id,name:id,updatedAt:1});
  }
  const a=createApp(seed);
  const variants:Record<string,string>[]=[];
  for(const page of ['1','2'])for(const pageSize of ['1','2'])for(const sort of ['name','updatedAt'])for(const direction of ['asc','desc'])variants.push({page,pageSize,sort,direction});
  const list=(id:string,query:Record<string,string>)=>a.request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query});
  for(const id of ids)for(const query of variants) {
    const result=list(id,query);
    assert.equal(result.status,200);
    const expected=createApp(seed).request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query});
    assert.deepEqual(result,expected);
  }
  const queries=a.db.counters.projectLists;
  assert.equal(queries,ids.length*variants.length);
  for(const id of ids)for(const query of variants)assert.equal(list(id,query).status,200);
  assert.equal(a.db.counters.projectLists,queries);
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:ids[1]}}).status,200);
  assert.equal(a.db.projects.get('a1')!.organizationId,'org-a');
  for(const id of ids.slice(1))for(const query of variants)assert.equal(list(id,query).status,200);
  assert.equal(a.db.counters.projectLists,queries);
  const updatedSeed=structuredClone(seed);
  updatedSeed.projects.find(p=>p.id==='a1')!.name='Zulu';
  updatedSeed.projects.find(p=>p.id==='a1')!.updatedAt++;
  for(const query of variants)assert.deepEqual(list('org-a',query),createApp(updatedSeed).request({method:'GET',path:'/organizations/org-a/projects',token:'both',query}));
  assert.equal(a.db.counters.projectLists,queries+variants.length);
});

test('revocation is enforced before serving cached lists or updating projects',()=>{
  const a=createApp(sampleSeed());
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(a.request(request).status,200);
  a.db.memberships.delete(JSON.stringify(['alice','org-a']));
  assert.deepEqual(a.request(request),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'No'}}),forbidden);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.equal(a.request({...request,token:'both'}).status,200);
  assert.equal(a.db.counters.projectLists,1);
});
