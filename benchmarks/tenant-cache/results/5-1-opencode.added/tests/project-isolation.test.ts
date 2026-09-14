import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { projectListKey } from '../src/cache/keys.ts';
import type { ListOptions } from '../src/types.ts';

test('nonmembers cannot read, update, or list projects, including cached lists',()=>{
  const cache=createCache(),app=createApp(sampleSeed(),cache);
  app.request({method:'GET',path:'/organizations/org-a/projects',token:'alice'});
  const projects=structuredClone(app.db.projects),keys=cache.keys(),metrics={...cache.metrics};
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(app.request({method,path:'/projects/a1',token:'bob',query:{organizationId:'org-b'},body:{name:'Stolen',organizationId:'org-b'}}),{status:403,body:{error:'forbidden'}});
  }
  assert.deepEqual(app.request({method:'GET',path:'/organizations/org-a/projects',token:'bob'}),{status:403,body:{error:'forbidden'}});
  assert.deepEqual(app.db.projects,projects);
  assert.equal(app.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  assert.equal(app.request({method:'GET',path:'/projects/missing',token:'alice'}).status,404);
});

test('switching organizations isolates cached lists and checks revoked membership',()=>{
  const cache=createCache(),app=createApp(sampleSeed(),cache);
  for(const organizationId of ['org-a','org-b','org-a','org-b']) {
    const response=app.request({method:'GET',path:`/organizations/${organizationId}/projects`,token:'both'});
    assert.equal(response.status,200);
    assert.ok((response.body as any).items.every((p:any)=>p.organizationId===organizationId));
  }
  assert.equal(app.db.counters.projectLists,2);
  assert.equal(cache.metrics.hits,2);
  app.db.memberships.delete(JSON.stringify(['both','org-a']));
  assert.equal(app.request({method:'GET',path:'/organizations/org-a/projects',token:'both'}).status,403);
  assert.equal(app.request({method:'GET',path:'/projects/a1',token:'both'}).status,403);
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:'Denied'}}).status,403);
  assert.equal(cache.metrics.hits,2);
  assert.equal(app.db.counters.projectUpdates,0);
});

test('updates invalidate all owning-organization variants and preserve other cached lists',()=>{
  const seed=sampleSeed();
  const otherId='org-a:"suffix';
  seed.organizations.push({id:otherId,name:'Other'});
  seed.memberships.push({userId:'both',organizationId:otherId});
  seed.projects.push({id:'other',organizationId:otherId,name:'Other',updatedAt:1});
  const cache=createCache(),app=createApp(seed,cache);
  const variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const)variants.push({page,pageSize,sort,direction});
  const list=(organizationId:string,options:ListOptions)=>app.request({method:'GET',path:`/organizations/${encodeURIComponent(organizationId)}/projects`,token:'both',query:{page:String(options.page),pageSize:String(options.pageSize),sort:options.sort,direction:options.direction}});
  for(const organizationId of ['org-a','org-b',otherId])for(const options of variants) {
    const response=list(organizationId,options);
    assert.equal(response.status,200);
    assert.deepEqual(response.body,{...options,total:organizationId===otherId?1:3,items:(response.body as any).items});
  }
  assert.equal(cache.keys().length,variants.length*3);
  const preserved=cache.keys().filter(key=>!variants.some(options=>key===projectListKey('org-a',options)));
  const snapshots=preserved.map(key=>cache.get(key));
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:''}}).status,400);
  assert.equal(cache.keys().length,variants.length*3);
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Zulu'}}).status,200);
  assert.deepEqual(cache.keys(),preserved);
  assert.deepEqual(preserved.map(key=>cache.get(key)),snapshots);
  const count=app.db.counters.projectLists;
  for(const organizationId of ['org-b',otherId])for(const options of variants)list(organizationId,options);
  assert.equal(app.db.counters.projectLists,count);
  const fresh=createApp({...seed,projects:[...app.db.projects.values()]});
  for(const options of variants) {
    const query={page:String(options.page),pageSize:String(options.pageSize),sort:options.sort,direction:options.direction};
    assert.deepEqual(list('org-a',options),fresh.request({method:'GET',path:'/organizations/org-a/projects',token:'alice',query}));
  }
  assert.equal(app.db.counters.projectLists,count+variants.length);
});
