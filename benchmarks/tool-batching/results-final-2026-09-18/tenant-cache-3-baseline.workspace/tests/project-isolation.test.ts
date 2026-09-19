import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { projectListKey } from '../src/cache/keys.ts';
import { projectRepository } from '../src/db/project-repository.ts';
import { createDatabase } from '../src/db/database.ts';
import type { ListOptions } from '../src/types.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read, update, or list projects, including cached lists',()=>{
  const cache=createCache(),app=createApp(sampleSeed(),cache);
  app.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const before=structuredClone([...app.db.projects]);
  const keys=cache.keys(),metrics={...cache.metrics};
  assert.deepEqual(app.request({method:'GET',path:'/projects/b1',token:'alice'}),forbidden);
  assert.deepEqual(app.request({method:'PATCH',path:'/projects/b1',token:'alice',body:{name:'Stolen'}}),forbidden);
  assert.deepEqual(app.request({method:'GET',path:'/organizations/org-b/projects',token:'alice'}),forbidden);
  app.db.memberships.delete(JSON.stringify(['bob','org-b']));
  assert.deepEqual(app.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'}),forbidden);
  assert.deepEqual([...app.db.projects],before);
  assert.equal(app.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
});

test('organization switching isolates all list variants and updates invalidate only the owning organization',()=>{
  const seed=sampleSeed();
  // Delimiter-containing IDs must not overlap another organization's namespace.
  seed.organizations[1].id='org-a:child';
  for(const p of seed.projects)if(p.organizationId==='org-b')p.organizationId='org-a:child';
  for(const m of seed.memberships)if(m.organizationId==='org-b')m.organizationId='org-a:child';
  const cache=createCache(),app=createApp(seed,cache);
  const expected=projectRepository(createDatabase(seed));
  const variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const){
    variants.push({page,pageSize,sort,direction});
  }
  const list=(org:string,options:ListOptions)=>app.request({method:'GET',path:`/organizations/${encodeURIComponent(org)}/projects`,token:'both',query:Object.fromEntries(Object.entries(options).map(([k,v])=>[k,String(v)]))});
  for(const org of ['org-a','org-a:child'])for(const options of variants){
    const response={status:200,body:expected.list(org,options)};
    assert.deepEqual(list(org,options),response);
    assert.deepEqual(list(org,options),response);
  }
  assert.equal(app.db.counters.projectLists,variants.length*2);
  assert.equal(cache.metrics.hits,variants.length*2);
  assert.equal(cache.keys().length,variants.length*2);
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'both',body:{name:' Zulu '}}).status,200);
  expected.update('a1','Zulu');
  for(const options of variants){
    assert.ok(!cache.keys().includes(projectListKey('org-a',options)));
    assert.ok(cache.keys().includes(projectListKey('org-a:child',options)));
  }
  const reads=app.db.counters.projectLists;
  for(const options of variants)assert.deepEqual(list('org-a:child',options),{status:200,body:expected.list('org-a:child',options)});
  assert.equal(app.db.counters.projectLists,reads);
  for(const options of variants)assert.deepEqual(list('org-a',options),{status:200,body:expected.list('org-a',options)});
  assert.equal(app.db.counters.projectLists,reads+variants.length);
});
