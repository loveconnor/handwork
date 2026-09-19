import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('owning organization controls reads and writes, without unauthorized mutations',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const projects=structuredClone(a.db.projects),keys=cache.keys(),metrics={...cache.metrics};
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{organizationId:'org-a',name:'Stolen'}}),forbidden);
  }
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual(a.db.projects,projects);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
  const updated=a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:' Renamed ',organizationId:'org-b'}});
  assert.deepEqual(updated,{status:200,body:{id:'a1',organizationId:'org-a',name:'Renamed',updatedAt:4}});
});

test('cached lists still check current membership',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(a.request(request).status,200);
  const metrics={...cache.metrics};
  a.db.memberships.delete(JSON.stringify(['alice','org-a']));
  assert.deepEqual(a.request(request),forbidden);
  assert.deepEqual(cache.metrics,metrics);
  assert.equal(a.db.counters.projectLists,1);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'No'}}),forbidden);
  assert.equal(a.db.counters.projectUpdates,0);
});

test('all list variants are isolated and only the updated organization is invalidated',()=>{
  const seed=sampleSeed();
  const organizations=['org-a','org-a:child','org-a"','org-a\\','org-b'];
  for(const id of organizations.slice(1,-1)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`${id}-project`,organizationId:id,name:'Other',updatedAt:1});
  }
  const cache=createCache(),a=createApp(seed,cache);
  const requests=organizations.flatMap(organizationId=>[1,2].flatMap(page=>[1,2].flatMap(pageSize=>['name','updatedAt'].flatMap(sort=>['asc','desc'].map(direction=>({
    method:'GET',path:`/organizations/${encodeURIComponent(organizationId)}/projects`,token:'both',
    query:{page:String(page),pageSize:String(pageSize),sort,direction},
  }))))));
  const initial=requests.map(request=>{
    const result=a.request(request);
    const uncached=createApp(seed).request(request);
    assert.equal(result.status,200);
    assert.deepEqual(result,uncached);
    return result;
  });
  assert.equal(a.db.counters.projectLists,requests.length);
  assert.equal(cache.keys().length,requests.length);
  requests.forEach((request,i)=>assert.deepEqual(a.request(request),initial[i]));
  assert.equal(a.db.counters.projectLists,requests.length);
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zeta'}}).status,200);
  const affected=requests.filter(request=>request.path==='/organizations/org-a/projects').length;
  assert.equal(cache.keys().length,requests.length-affected);
  const fresh=createApp({...seed,projects:[...a.db.projects.values()]});
  requests.forEach(request=>assert.deepEqual(a.request(request),fresh.request(request)));
  assert.equal(a.db.counters.projectLists,requests.length+affected);
  requests.forEach(request=>a.request(request));
  assert.equal(a.db.counters.projectLists,requests.length+affected);
});
