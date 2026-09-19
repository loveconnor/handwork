import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read, update, or list projects, even with spoofed ownership',()=>{
  const a=createApp(sampleSeed());
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const stored=structuredClone([...a.db.projects]);
  const cached=a.cache.keys().map(key=>[key,a.cache.get(key)]);
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  }
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual([...a.db.projects],stored);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(a.cache.keys().map(key=>[key,a.cache.get(key)]),cached);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('cached lists still require current membership',()=>{
  const a=createApp(sampleSeed());
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(a.request(request).status,200);
  const keys=a.cache.keys();
  a.db.memberships.delete(JSON.stringify(['alice','org-a']));
  assert.deepEqual(a.request(request),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'No'}}),forbidden);
  assert.deepEqual(a.cache.keys(),keys);
  assert.equal(a.db.counters.projectLists,1);
  assert.equal(a.db.counters.projectUpdates,0);
});

test('organization and option variants stay isolated; updates invalidate only the owner',()=>{
  const seed=sampleSeed();
  const ids=['org-a','org-a:child','org-a"', 'org-a\\', 'org-b'];
  for(const id of ids.slice(1,-1)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`${id}-project`,organizationId:id,name:'Other',updatedAt:1});
  }
  const a=createApp(seed);
  const variants:Record<string,string>[]=[];
  for(const page of ['1','2'])for(const pageSize of ['1','2'])for(const sort of ['name','updatedAt'])for(const direction of ['asc','desc'])variants.push({page,pageSize,sort,direction});
  const list=(id:string,query:Record<string,string>)=>a.request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query});
  const expected=(id:string,query:Record<string,string>)=>{
    const rows=[...a.db.projects.values()].filter(p=>p.organizationId===id).sort((x,y)=>{
      const primary=query.sort==='name'?x.name.localeCompare(y.name):x.updatedAt-y.updatedAt;
      return (primary||x.id.localeCompare(y.id))*(query.direction==='asc'?1:-1);
    });
    const page=Number(query.page),pageSize=Number(query.pageSize);
    return {status:200,body:{items:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize,sort:query.sort,direction:query.direction}};
  };
  for(const id of ids)for(const query of variants)assert.deepEqual(list(id,query),expected(id,query));
  const warmed=a.db.counters.projectLists;
  assert.equal(warmed,ids.length*variants.length);
  for(const id of ids)for(const query of variants)assert.deepEqual(list(id,query),expected(id,query));
  assert.equal(a.db.counters.projectLists,warmed);
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:'org-b'}}).status,200);
  assert.equal(a.db.projects.get('a1')!.organizationId,'org-a');
  for(const id of ids.slice(1))for(const query of variants)assert.deepEqual(list(id,query),expected(id,query));
  assert.equal(a.db.counters.projectLists,warmed);
  for(const query of variants)assert.deepEqual(list('org-a',query),expected('org-a',query));
  assert.equal(a.db.counters.projectLists,warmed+variants.length);
  for(const query of variants)assert.deepEqual(list('org-a',query),expected('org-a',query));
  assert.equal(a.db.counters.projectLists,warmed+variants.length);
});
