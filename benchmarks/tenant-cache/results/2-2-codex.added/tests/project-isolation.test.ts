import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { membershipRepository } from '../src/db/membership-repository.ts';
import { sampleSeed } from '../src/seed.ts';

const forbidden = {status:403,body:{error:'forbidden'}};

test('nonmembers cannot read or update projects, including with spoofed ownership', () => {
  const cache=createCache(), app=createApp(sampleSeed(),cache);
  app.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const projects=structuredClone(app.db.projects), keys=cache.keys(), metrics={...cache.metrics};
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(app.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Changed',organizationId:'org-a'}}),forbidden);
  }
  assert.deepEqual(app.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual(app.db.projects,projects);
  assert.equal(app.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual(app.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('cached lists and project access recheck revoked membership', () => {
  const cache=createCache(), app=createApp(sampleSeed(),cache);
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(app.request(request).status,200);
  assert.equal(app.request(request).status,200);
  assert.equal(app.db.counters.projectLists,1);
  membershipRepository(app.db).revoke('alice','org-a');
  const metrics={...cache.metrics};
  assert.deepEqual(app.request(request),forbidden);
  assert.deepEqual(app.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(app.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Changed'}}),forbidden);
  assert.deepEqual(cache.metrics,metrics);
  assert.equal(app.db.counters.projectUpdates,0);
});

test('all list options remain distinct and updates invalidate only the owning organization', () => {
  const seed=sampleSeed();
  // Include opaque IDs with shared prefixes, delimiters, and escaped punctuation.
  const ids=['org-a','org-a:child','org-a%3Achild','org-b'];
  for(const id of ids.slice(1,3)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`${id}-project`,organizationId:id,name:'Other',updatedAt:1});
  }
  const app=createApp(seed);
  const variants:Record<string,string>[]=[];
  for(const page of ['1','2'])for(const pageSize of ['1','2'])for(const sort of ['name','updatedAt'])for(const direction of ['asc','desc']) {
    variants.push({page,pageSize,sort,direction});
  }
  const list=(id:string,query:Record<string,string>)=>app.request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query});
  const snapshots=new Map<string,unknown[]>();
  for(const id of ids) {
    snapshots.set(id,variants.map(query=>{
      const result=list(id,query);
      const expected=createApp(seed).request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query});
      assert.equal(result.status,200);
      assert.deepEqual(result,expected);
      return result;
    }));
  }
  const warmed=app.db.counters.projectLists;
  for(const id of ids)variants.forEach((query,i)=>assert.deepEqual(list(id,query),snapshots.get(id)![i]));
  assert.equal(app.db.counters.projectLists,warmed);
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:' Zulu ',organizationId:'org-b'}}).status,200);
  assert.equal(app.db.projects.get('a1')!.organizationId,'org-a');
  for(const id of ids.slice(1))variants.forEach((query,i)=>assert.deepEqual(list(id,query),snapshots.get(id)![i]));
  assert.equal(app.db.counters.projectLists,warmed);
  const updatedSeed={...seed,projects:[...app.db.projects.values()]};
  for(const query of variants) {
    const result=list('org-a',query);
    assert.deepEqual(result,createApp(updatedSeed).request({method:'GET',path:'/organizations/org-a/projects',token:'both',query}));
    assert.deepEqual(list('org-a',query),result);
  }
  assert.equal(app.db.counters.projectLists,warmed+variants.length);
});
