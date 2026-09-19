import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import type { ListOptions } from '../src/types.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read or update projects, even with spoofed ownership',()=>{
  const a=createApp(sampleSeed());
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const stored=structuredClone(a.db.projects);
  const cached=a.cache.keys().map(key=>[key,a.cache.get(key)]);
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  }
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual(a.db.projects,stored);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(a.cache.keys().map(key=>[key,a.cache.get(key)]),cached);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('membership revocation is checked before serving a cached list',()=>{
  const a=createApp(sampleSeed());
  const request={method:'GET',path:'/organizations/org-a/projects',token:'alice'};
  assert.equal(a.request(request).status,200);
  a.db.memberships.delete(JSON.stringify(['alice','org-a']));
  assert.deepEqual(a.request(request),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'No'}}),forbidden);
  assert.equal(a.db.counters.projectLists,1);
  assert.equal(a.db.counters.projectUpdates,0);
});

test('list variants stay isolated and updates invalidate only the owning organization',()=>{
  const seed=sampleSeed();
  // Shared prefixes and punctuation must not broaden invalidation.
  const ids=['org-a','org-a:child','org-a"\\:child'];
  for(const id of ids.slice(1)) {
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`${id}-project`,organizationId:id,name:'Other',updatedAt:1});
  }
  ids.push('org-b');
  const a=createApp(seed);
  const variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const) {
    variants.push({page,pageSize,sort,direction});
  }
  function list(id:string,options:ListOptions) {
    return a.request({method:'GET',path:`/organizations/${id}/projects`,token:'both',query:Object.fromEntries(Object.entries(options).map(([k,v])=>[k,String(v)]))});
  }
  function expected(id:string,options:ListOptions) {
    const rows=[...a.db.projects.values()].filter(p=>p.organizationId===id).sort((a,b)=>{
      const primary=options.sort==='name'?a.name.localeCompare(b.name):a.updatedAt-b.updatedAt;
      return (primary||a.id.localeCompare(b.id))*(options.direction==='asc'?1:-1);
    });
    return {status:200,body:{items:rows.slice((options.page-1)*options.pageSize,options.page*options.pageSize),total:rows.length,...options}};
  }
  for(const id of ids)for(const options of variants)assert.deepEqual(list(id,options),expected(id,options));
  const queries=ids.length*variants.length;
  assert.equal(a.db.counters.projectLists,queries);
  assert.equal(a.cache.keys().length,queries);
  for(const id of ids)for(const options of variants)assert.deepEqual(list(id,options),expected(id,options));
  assert.equal(a.db.counters.projectLists,queries);
  assert.equal(a.request({method:'PATCH',path:'/projects/a2',token:'both',body:{name:'Zulu',organizationId:'org-b'}}).status,200);
  assert.equal(a.db.projects.get('a2')!.organizationId,'org-a');
  assert.equal(a.cache.keys().length,queries-variants.length);
  for(const id of ids.slice(1))for(const options of variants)assert.deepEqual(list(id,options),expected(id,options));
  assert.equal(a.db.counters.projectLists,queries);
  for(const options of variants)assert.deepEqual(list('org-a',options),expected('org-a',options));
  assert.equal(a.db.counters.projectLists,queries+variants.length);
  for(const options of variants)assert.deepEqual(list('org-a',options),expected('org-a',options));
  assert.equal(a.db.counters.projectLists,queries+variants.length);
});
