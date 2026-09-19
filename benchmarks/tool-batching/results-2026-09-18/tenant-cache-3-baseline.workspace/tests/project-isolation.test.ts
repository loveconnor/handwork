import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { membershipRepository } from '../src/db/membership-repository.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read or update projects, even with spoofed ownership',()=>{
  const a=createApp(sampleSeed());
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const storage=structuredClone(a.db.projects),keys=a.cache.keys();
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  }
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual(a.db.projects,storage);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(a.cache.keys(),keys);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('cached results still require current membership',()=>{
  const a=createApp(sampleSeed());
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(a.request(request).status,200);
  assert.equal(a.request(request).status,200);
  assert.equal(a.db.counters.projectLists,1);
  membershipRepository(a.db).revoke('alice','org-a');
  assert.deepEqual(a.request(request),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'No'}}),forbidden);
  assert.equal(a.db.counters.projectLists,1);
  assert.equal(a.db.counters.projectUpdates,0);
});

test('organization and option variants stay isolated and only owning lists are invalidated',()=>{
  const seed=sampleSeed();
  // Opaque IDs with shared prefixes and punctuation must not share invalidation groups.
  const other='org-a:"suffix';
  seed.organizations[1].id=other;
  for(const p of seed.projects)if(p.organizationId==='org-b')p.organizationId=other;
  for(const m of seed.memberships)if(m.organizationId==='org-b')m.organizationId=other;
  const a=createApp(seed);
  const variants:Record<string,string>[]=[];
  for(const page of ['1','2'])for(const pageSize of ['1','2'])for(const sort of ['name','updatedAt'])for(const direction of ['asc','desc'])variants.push({page,pageSize,sort,direction});
  const list=(organizationId:string,query:Record<string,string>)=>a.request({method:'GET',path:`/organizations/${organizationId}/projects`,token:'both',query});
  const expected=(organizationId:string,query:Record<string,string>)=>{
    const rows=[...a.db.projects.values()].filter(p=>p.organizationId===organizationId);
    rows.sort((x,y)=>((query.sort==='name'?x.name.localeCompare(y.name):x.updatedAt-y.updatedAt)||x.id.localeCompare(y.id))*(query.direction==='asc'?1:-1));
    const page=Number(query.page),pageSize=Number(query.pageSize);
    return {status:200,body:{items:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize,sort:query.sort,direction:query.direction}};
  };
  for(const query of variants)for(const org of ['org-a',other])assert.deepEqual(list(org,query),expected(org,query));
  assert.equal(a.db.counters.projectLists,32);
  for(const query of variants)for(const org of ['org-a',other])assert.deepEqual(list(org,query),expected(org,query));
  assert.equal(a.db.counters.projectLists,32);
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Zulu',organizationId:other}}).status,200);
  assert.equal(a.db.projects.get('a1')!.organizationId,'org-a');
  for(const query of variants)assert.deepEqual(list(other,query),expected(other,query));
  assert.equal(a.db.counters.projectLists,32);
  for(const query of variants)assert.deepEqual(list('org-a',query),expected('org-a',query));
  assert.equal(a.db.counters.projectLists,48);
  for(const query of variants)assert.deepEqual(list('org-a',query),expected('org-a',query));
  assert.equal(a.db.counters.projectLists,48);
});
