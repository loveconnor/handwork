import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';

const forbidden={status:403,body:{error:'forbidden'}};
test('nonmembers cannot read or update projects, including forged ownership',()=>{
  const a=createApp(sampleSeed());
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const projects=structuredClone([...a.db.projects]);
  const entries=a.cache.keys().map(key=>[key,a.cache.get(key)]);
  for(const method of ['GET','PATCH'])assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual([...a.db.projects],projects);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(a.cache.keys().map(key=>[key,a.cache.get(key)]),entries);
  assert.equal(a.request({method:'GET',path:'/projects/missing',token:'alice'}).status,404);
});

test('all list variants isolate organizations and only owning lists are invalidated',()=>{
  const seed=sampleSeed();
  const other='org-a:"\\suffix';
  seed.organizations[1].id=other;
  for(const m of seed.memberships)if(m.organizationId==='org-b')m.organizationId=other;
  for(const p of seed.projects)if(p.organizationId==='org-b')p.organizationId=other;
  const a=createApp(seed);
  const variants=[];
  for(const page of ['1','2'])for(const pageSize of ['1','2'])for(const sort of ['name','updatedAt'])for(const direction of ['asc','desc'])variants.push({page,pageSize,sort,direction});
  const list=(org:string,query:Record<string,string>)=>a.request({method:'GET',path:`/organizations/${org}/projects`,token:'both',query});
  for(const org of ['org-a',other])for(const query of variants){
    const result=list(org,query);
    assert.equal(result.status,200);
    const rows=seed.projects.filter(p=>p.organizationId===org).sort((x,y)=>((query.sort==='name'?x.name.localeCompare(y.name):x.updatedAt-y.updatedAt)||x.id.localeCompare(y.id))*(query.direction==='asc'?1:-1));
    const start=(Number(query.page)-1)*Number(query.pageSize);
    assert.deepEqual(result.body,{items:rows.slice(start,start+Number(query.pageSize)),total:rows.length,page:Number(query.page),pageSize:Number(query.pageSize),sort:query.sort,direction:query.direction});
    assert.deepEqual(list(org,query),result);
  }
  assert.equal(a.db.counters.projectLists,variants.length*2);
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Zulu'}}).status,200);
  for(const query of variants)assert.equal(list(other,query).status,200);
  assert.equal(a.db.counters.projectLists,variants.length*2);
  for(const query of variants){
    const fresh=list('org-a',query);
    const uncached=createApp({...seed,projects:[...a.db.projects.values()]});
    assert.deepEqual(fresh,uncached.request({method:'GET',path:'/organizations/org-a/projects',token:'both',query}));
    assert.deepEqual(list('org-a',query),fresh);
  }
  assert.equal(a.db.counters.projectLists,variants.length*3);
});

test('revoked membership denies cached lists and project access without mutation',()=>{
  const a=createApp(sampleSeed());
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(a.request(request).status,200);
  a.db.memberships.delete(JSON.stringify(['alice','org-a']));
  const entries=a.cache.keys().map(key=>[key,a.cache.get(key)]);
  assert.deepEqual(a.request(request),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'No'}}),forbidden);
  assert.equal(a.db.counters.projectLists,1);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(a.cache.keys().map(key=>[key,a.cache.get(key)]),entries);
});
