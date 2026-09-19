import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read, update, or list projects, including warm caches',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  a.request({method:'GET',path:'/organizations/org-a/projects',token:'alice'});
  const storage=structuredClone(a.db.projects),keys=cache.keys(),metrics={...cache.metrics};
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'bob',query:{organizationId:'org-b'}}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'bob',body:{name:'Stolen',organizationId:'org-b'}}),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-a/projects',token:'bob'}),forbidden);
  a.db.memberships.delete(JSON.stringify(['alice','org-a']));
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-a/projects',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Revoked'}}),forbidden);
  assert.deepEqual(a.db.projects,storage);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'bob'}),{status:404,body:{error:'not_found'}});
});

test('organization and option variants remain cached and updates invalidate only the owner',()=>{
  const seed=sampleSeed();
  // Opaque IDs deliberately share prefixes and contain cache delimiters and quotes.
  const ids=['org:a','org:a:child','org:a"'];
  for(const id of ids){
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`${id}-project`,organizationId:id,name:id,updatedAt:1});
  }
  const a=createApp(seed);
  const variants:Record<string,string>[]=[];
  for(const page of ['1','2'])for(const pageSize of ['1','2'])
    for(const sort of ['name','updatedAt'])for(const direction of ['asc','desc'])
      variants.push({page,pageSize,sort,direction});
  const organizations=['org-a','org-b',...ids];
  const list=(id:string,query:Record<string,string>)=>a.request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query});
  const fresh=createApp(seed);
  for(const id of organizations)for(const query of variants){
    const result=list(id,query);
    assert.deepEqual(result,fresh.request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query}));
    const count=a.db.counters.projectLists;
    assert.deepEqual(list(id,query),result);
    assert.equal(a.db.counters.projectLists,count);
  }
  assert.equal(a.db.counters.projectLists,organizations.length*variants.length);
  for(const owner of ['org-a',ids[0]]){
    const projectId=owner==='org-a'?'a1':`${owner}-project`;
    assert.equal(a.request({method:'PATCH',path:`/projects/${encodeURIComponent(projectId)}`,token:'both',body:{name:'Zulu',organizationId:'org-b'}}).status,200);
    assert.equal(a.db.projects.get(projectId)!.organizationId,owner);
    const expected=createApp({...seed,projects:[...a.db.projects.values()]});
    for(const id of organizations)for(const query of variants){
      const count=a.db.counters.projectLists;
      const result=list(id,query);
      assert.deepEqual(result,expected.request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query}));
      assert.equal(a.db.counters.projectLists,count+(id===owner?1:0));
      assert.deepEqual(list(id,query),result);
      assert.equal(a.db.counters.projectLists,count+(id===owner?1:0));
    }
  }
});
