import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { projectListKey } from '../src/cache/keys.ts';
import type { ListOptions } from '../src/types.ts';

const forbidden={status:403,body:{error:'forbidden'}};
const defaults:ListOptions={page:1,pageSize:10,sort:'name',direction:'asc'};

test('nonmembers cannot read, update, or list projects, including warm caches',()=>{
  const cache=createCache(),a=createApp(sampleSeed(),cache);
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const stored=structuredClone(a.db.projects),keys=cache.keys(),metrics={...cache.metrics};
  for(const method of ['GET','PATCH'])assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  assert.deepEqual(a.db.projects,stored);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  a.db.memberships.delete(JSON.stringify(['bob','org-b']));
  assert.deepEqual(a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'}),forbidden);
  assert.deepEqual(cache.metrics,metrics);
  assert.deepEqual(a.request({method:'GET',path:'/projects/missing',token:'alice'}),{status:404,body:{error:'not_found'}});
});

test('organization switching and all list variants stay isolated and selectively refresh',()=>{
  const seed=sampleSeed();
  // Include IDs that share prefixes and contain cache delimiters and quotes.
  const ids=['org-a','org-a:child','org-a"', 'org-a\\'];
  for(const [i,id] of ids.entries()){
    if(i===0)continue;
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`extra-${i}`,organizationId:id,name:'Other',updatedAt:1});
  }
  const a=createApp(seed);
  const list=(id:string,options:ListOptions=defaults)=>a.request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query:Object.fromEntries(Object.entries(options).map(([k,v])=>[k,String(v)]))});
  const variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const)variants.push({page,pageSize,sort,direction});
  const snapshots=new Map<string,unknown>();
  for(const id of [...ids,'org-b'])for(const options of variants){
    const r=list(id,options);
    assert.equal(r.status,200);
    const body=r.body as any;
    assert.ok(body.items.every((p:any)=>p.organizationId===id));
    assert.deepEqual({page:body.page,pageSize:body.pageSize,sort:body.sort,direction:body.direction},options);
    snapshots.set(projectListKey(id,options),r);
  }
  assert.equal(a.cache.keys().length,5*variants.length);
  const count=a.db.counters.projectLists;
  for(const id of [...ids,'org-b'])for(const options of variants)assert.deepEqual(list(id,options),snapshots.get(projectListKey(id,options)));
  assert.equal(a.db.counters.projectLists,count);
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Zulu',organizationId:'org-b'}}).status,200);
  assert.equal(a.db.projects.get('a1')!.organizationId,'org-a');
  for(const options of variants)assert.ok(!a.cache.keys().includes(projectListKey('org-a',options)));
  for(const id of [...ids.slice(1),'org-b'])for(const options of variants)assert.deepEqual(list(id,options),snapshots.get(projectListKey(id,options)));
  assert.equal(a.db.counters.projectLists,count);
  const fresh=createApp({...seed,projects:[...a.db.projects.values()]});
  for(const options of variants){
    const expected=fresh.request({method:'GET',path:'/organizations/org-a/projects',token:'both',query:Object.fromEntries(Object.entries(options).map(([k,v])=>[k,String(v)]))});
    assert.deepEqual(list('org-a',options),expected);
    assert.deepEqual(list('org-a',options),expected);
  }
  assert.equal(a.db.counters.projectLists,count+variants.length);
});
