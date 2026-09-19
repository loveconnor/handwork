import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';

test('nonmembers cannot read or update projects, even with spoofed ownership',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const storage=structuredClone(a.db.projects),keys=cache.keys(),metrics={...cache.metrics};
  for(const method of ['GET','PATCH'])assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),{status:403,body:{error:'forbidden'}});
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),{status:403,body:{error:'forbidden'}});
  assert.deepEqual(a.db.projects,storage);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('cached lists check current membership',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(a.request(request).status,200);
  a.db.memberships.delete(JSON.stringify(['alice','org-a']));
  const metrics={...cache.metrics};
  assert.deepEqual(a.request(request),{status:403,body:{error:'forbidden'}});
  assert.deepEqual(cache.metrics,metrics);
  for(const method of ['GET','PATCH'])assert.equal(a.request({method,path:'/projects/a1',token:'alice',body:{name:'Denied'}}).status,403);
});

test('lists isolate organizations and all options; updates invalidate only owning lists',()=>{
  const seed=sampleSeed();
  const ids=['org-a','org-a:child','org-a"/:child'];
  for(const id of ids.slice(1)){
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`project-${id}`,organizationId:id,name:'Other',updatedAt:1});
  }
  ids.push('org-b');
  const a=createApp(seed);
  const requests=ids.flatMap(id=>[1,2].flatMap(page=>[1,2].flatMap(pageSize=>['name','updatedAt'].flatMap(sort=>['asc','desc'].map(direction=>({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query:{page:String(page),pageSize:String(pageSize),sort,direction}}))))));
  const responses=requests.map(request=>{
    const result=a.request(request);
    assert.equal(result.status,200);
    // Compare every variant against an uncached application, including sorting and pagination.
    assert.deepEqual(result,createApp(seed).request(request));
    return result;
  });
  assert.equal(a.db.counters.projectLists,requests.length);
  requests.forEach((request,i)=>assert.deepEqual(a.request(request),responses[i]));
  assert.equal(a.db.counters.projectLists,requests.length);
  const keys=a.cache.keys();
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:''}}).status,400);
  assert.deepEqual(a.cache.keys(),keys);
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:'org-b'}}).status,200);
  assert.equal(a.db.projects.get('a1')!.organizationId,'org-a');
  const updatedSeed=sampleSeed();
  updatedSeed.projects[0]={...updatedSeed.projects[0],name:'Zulu',updatedAt:4};
  let refreshed=0;
  requests.forEach((request,i)=>{
    const result=a.request(request);
    if(request.path==='/organizations/org-a/projects'){
      refreshed++;
      assert.deepEqual(result,createApp(updatedSeed).request(request));
    }else assert.deepEqual(result,responses[i]);
    assert.equal(a.db.counters.projectLists,requests.length+refreshed);
  });
  requests.forEach(request=>a.request(request));
  assert.equal(a.db.counters.projectLists,requests.length+refreshed);
});
