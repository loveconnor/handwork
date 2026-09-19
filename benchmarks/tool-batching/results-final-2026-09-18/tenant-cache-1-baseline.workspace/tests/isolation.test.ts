import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read or update projects, even with spoofed ownership',()=>{
  const cache=createCache(), app=createApp(sampleSeed(),cache);
  app.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const before=structuredClone([...app.db.projects]);
  const entries=cache.keys().map(key=>[key,cache.get(key)]);
  const metrics={...cache.metrics};
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(app.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  }
  assert.deepEqual(app.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual([...app.db.projects],before);
  assert.equal(app.db.counters.projectUpdates,0);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual(cache.keys().map(key=>[key,cache.get(key)]),entries);
  assert.deepEqual(app.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('membership is rechecked for cached lists and project access after revocation',()=>{
  const cache=createCache(), app=createApp(sampleSeed(),cache);
  const list={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(app.request(list).status,200);
  const metrics={...cache.metrics};
  app.db.memberships.delete(JSON.stringify(['alice','org-a']));
  assert.deepEqual(app.request(list),forbidden);
  assert.deepEqual(app.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(app.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'No'}}),forbidden);
  assert.deepEqual(cache.metrics,metrics);
  assert.equal(app.db.counters.projectUpdates,0);
});

test('all list variants isolate organizations and only the updated organization is invalidated',()=>{
  const seed=sampleSeed();
  const ids=['org-a','org-a:child','org-a" : / %'];
  for(const id of ids.slice(1)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`project-${id}`,organizationId:id,name:'Other',updatedAt:9});
  }
  const app=createApp(seed);
  const requests=[];
  for(const id of [...ids,'org-b'])for(const page of ['1','2'])for(const pageSize of ['1','2'])for(const sort of ['name','updatedAt'])for(const direction of ['asc','desc']) {
    requests.push({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query:{page,pageSize,sort,direction}});
  }
  const expected=requests.map(request=>{
    const response=app.request(request);
    // A fresh app provides the uncached response for each variant.
    assert.deepEqual(response,createApp(seed).request(request));
    assert.equal(response.status,200);
    return response;
  });
  assert.equal(app.db.counters.projectLists,requests.length);
  requests.forEach((request,i)=>assert.deepEqual(app.request(request),expected[i]));
  assert.equal(app.db.counters.projectLists,requests.length);
  const keys=app.cache.keys();
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:''}}).status,400);
  assert.deepEqual(app.cache.keys(),keys);
  const update=app.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:' Zulu ',organizationId:'org-b'}});
  assert.deepEqual(update,{status:200,body:{id:'a1',organizationId:'org-a',name:'Zulu',updatedAt:4}});
  assert.equal(app.cache.keys().length,requests.length-16);
  requests.forEach((request,i)=>{
    if(request.path!=='/organizations/org-a/projects')assert.deepEqual(app.request(request),expected[i]);
  });
  assert.equal(app.db.counters.projectLists,requests.length);
  const updatedSeed=sampleSeed();
  updatedSeed.projects[0]={id:'a1',organizationId:'org-a',name:'Zulu',updatedAt:4};
  for(const request of requests.filter(r=>r.path==='/organizations/org-a/projects')) {
    const response=app.request(request);
    assert.deepEqual(response,createApp(updatedSeed).request(request));
    assert.deepEqual(app.request(request),response);
  }
  assert.equal(app.db.counters.projectLists,requests.length+16);
});
