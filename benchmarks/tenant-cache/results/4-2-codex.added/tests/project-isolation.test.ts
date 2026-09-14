import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';

const forbidden={status:403,body:{error:'forbidden'}};
const listPath=(id:string)=>`/organizations/${encodeURIComponent(id)}/projects`;

test('project authorization uses stored ownership and rejected requests leave storage and cache intact',()=>{
  const app=createApp(sampleSeed());
  app.request({method:'GET',path:listPath('org-b'),token:'bob'});
  const projects=structuredClone([...app.db.projects]);
  const cached=app.cache.keys().map(key=>[key,app.cache.get(key)]);
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(app.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  }
  assert.deepEqual(app.request({method:'GET',path:listPath('org-b'),token:'alice'}),forbidden);
  assert.deepEqual([...app.db.projects],projects);
  assert.equal(app.db.counters.projectUpdates,0);
  assert.deepEqual(app.cache.keys().map(key=>[key,app.cache.get(key)]),cached);
  assert.deepEqual(app.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('organization switching isolates cached lists and membership revocation applies on cache hits',()=>{
  const app=createApp(sampleSeed());
  for(const org of ['org-a','org-b','org-a','org-b']) {
    const response=app.request({method:'GET',path:listPath(org),token:'both'});
    assert.equal(response.status,200);
    assert.ok((response.body as any).items.every((p:any)=>p.organizationId===org));
  }
  assert.equal(app.db.counters.projectLists,2);
  app.db.memberships.delete(JSON.stringify(['both','org-a']));
  assert.deepEqual(app.request({method:'GET',path:listPath('org-a'),token:'both'}),forbidden);
  assert.deepEqual(app.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Denied'}}),forbidden);
  assert.equal(app.db.counters.projectLists,2);
});

test('updates invalidate all owning organization variants while preserving opaque neighboring organization keys',()=>{
  const seed=sampleSeed();
  const ids=['org-a','org-a:child','org-a"','org-a\\','org-b'];
  for(const id of ids.slice(1,-1)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`project-${id}`,organizationId:id,name:'Neighbor',updatedAt:1});
  }
  const app=createApp(seed);
  const queries:Record<string,string>[]=[];
  for(const page of ['1','2']) for(const pageSize of ['1','2'])
    for(const sort of ['name','updatedAt']) for(const direction of ['asc','desc'])
      queries.push({page,pageSize,sort,direction});
  const read=(org:string,query:Record<string,string>)=>app.request({method:'GET',path:listPath(org),token:'both',query});
  for(const org of ids) for(const query of queries) {
    const first=read(org,query);
    assert.equal(first.status,200);
    const fresh=createApp(seed).request({method:'GET',path:listPath(org),token:'both',query});
    assert.deepEqual(first,fresh);
    assert.deepEqual(read(org,query),first);
  }
  assert.equal(app.db.counters.projectLists,ids.length*queries.length);
  const updated=app.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:'org-b'}});
  assert.equal(updated.status,200);
  assert.equal((updated.body as any).organizationId,'org-a');
  const count=app.db.counters.projectLists;
  for(const org of ids.slice(1)) for(const query of queries) read(org,query);
  assert.equal(app.db.counters.projectLists,count);
  const freshSeed={...seed,projects:[...app.db.projects.values()]};
  for(const query of queries) {
    const result=read('org-a',query);
    assert.deepEqual(result,createApp(freshSeed).request({method:'GET',path:listPath('org-a'),token:'both',query}));
    assert.deepEqual(read('org-a',query),result);
  }
  assert.equal(app.db.counters.projectLists,count+queries.length);
});
