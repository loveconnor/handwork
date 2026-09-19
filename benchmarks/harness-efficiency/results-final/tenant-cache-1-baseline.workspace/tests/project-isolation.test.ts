import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { sampleSeed } from '../src/seed.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read or update projects, including with spoofed ownership',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const stored=structuredClone([...a.db.projects]),metrics={...cache.metrics},keys=cache.keys();
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  }
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual([...a.db.projects],stored);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('revoked membership is checked before cached lists, reads, and updates',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(a.request(request).status,200);
  assert.equal(a.request(request).status,200);
  assert.equal(cache.metrics.hits,1);
  a.db.memberships.delete(JSON.stringify(['alice','org-a']));
  const metrics={...cache.metrics};
  assert.deepEqual(a.request(request),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Denied'}}),forbidden);
  assert.deepEqual(cache.metrics,metrics);
  assert.equal(a.db.counters.projectUpdates,0);
});

test('list variants isolate opaque organization IDs and invalidate only the owner',()=>{
  const seed=sampleSeed();
  const organizations=['org-a','org-a:child','org-a"', 'org-a\\'];
  seed.organizations=organizations.map(id=>({id,name:id}));
  seed.memberships=organizations.map(organizationId=>({userId:'both',organizationId}));
  seed.projects=organizations.flatMap((organizationId,index)=>[
    {id:`${index}-1`,organizationId,name:'Alpha',updatedAt:3},
    {id:`${index}-2`,organizationId,name:'Beta',updatedAt:1},
    {id:`${index}-3`,organizationId,name:'Gamma',updatedAt:2},
  ]);
  const a=createApp(seed),fresh=createApp(seed);
  const requests=organizations.flatMap(id=>[1,2].flatMap(page=>[1,2].flatMap(pageSize=>['name','updatedAt'].flatMap(sort=>['asc','desc'].map(direction=>({
    method:'GET',path:`/organizations/${id}/projects`,token:'both',query:{page:String(page),pageSize:String(pageSize),sort,direction},
  }))))));
  for(const request of requests) {
    const expected=fresh.request(request);
    assert.equal(expected.status,200);
    assert.deepEqual(a.request(request),expected);
  }
  assert.equal(a.cache.keys().length,requests.length);
  const count=a.db.counters.projectLists;
  for(const request of requests)assert.equal(a.request(request).status,200);
  assert.equal(a.db.counters.projectLists,count);
  const update={method:'PATCH',path:'/projects/0-1',token:'both',body:{name:'Zeta',organizationId:organizations[1]}};
  assert.deepEqual(a.request(update),fresh.request(update));
  assert.equal(a.cache.keys().length,requests.length-16);
  for(const request of requests.filter(r=>r.path!=='/organizations/org-a/projects'))assert.deepEqual(a.request(request),fresh.request(request));
  assert.equal(a.db.counters.projectLists,count);
  for(const request of requests.filter(r=>r.path==='/organizations/org-a/projects'))assert.deepEqual(a.request(request),fresh.request(request));
  assert.equal(a.db.counters.projectLists,count+16);
  for(const request of requests)a.request(request);
  assert.equal(a.db.counters.projectLists,count+16);
});
