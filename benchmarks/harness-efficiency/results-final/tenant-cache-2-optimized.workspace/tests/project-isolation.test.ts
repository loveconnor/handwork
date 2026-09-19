import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { createCache } from '../src/cache/project-cache.ts';
import { projectListKey, projectListPrefix } from '../src/cache/keys.ts';
import { sampleSeed } from '../src/seed.ts';
import type { ListOptions } from '../src/types.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('nonmembers cannot read, update, or list projects, including cached lists',()=>{
  const cache=createCache(),app=createApp(sampleSeed(),cache);
  const path='/organizations/org-b/projects';
  assert.equal(app.request({method:'GET',path,token:'bob'}).status,200);
  const before=structuredClone(app.db.projects),keys=cache.keys(),metrics={...cache.metrics};
  assert.deepEqual(app.request({method:'GET',path:'/projects/b1',token:'alice'}),forbidden);
  for(const body of [{name:'Stolen'},{name:''}]){
    assert.deepEqual(app.request({method:'PATCH',path:'/projects/b1',token:'alice',body}),forbidden);
  }
  assert.deepEqual(app.request({method:'GET',path,token:'alice'}),forbidden);
  app.db.memberships.delete(JSON.stringify(['bob','org-b']));
  assert.deepEqual(app.request({method:'GET',path,token:'bob'}),forbidden);
  assert.deepEqual(app.db.projects,before);
  assert.equal(app.db.counters.projectUpdates,0);
  assert.deepEqual(cache.keys(),keys);
  assert.deepEqual(cache.metrics,metrics);
  for(const method of ['GET','PATCH']){
    assert.deepEqual(app.request({method,path:'/projects/missing',token:'alice',body:{name:'New'}}),{status:404,body:{error:'not_found'}});
  }
});

test('organization switching and all list variants stay isolated and refresh after updates',()=>{
  const cache=createCache(),app=createApp(sampleSeed(),cache);
  const variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const){
    variants.push({page,pageSize,sort,direction});
  }
  const list=(organizationId:string,options:ListOptions)=>app.request({
    method:'GET',path:`/organizations/${organizationId}/projects`,token:'both',
    query:Object.fromEntries(Object.entries(options).map(([key,value])=>[key,String(value)])),
  });
  for(const options of variants){
    for(const organizationId of ['org-a','org-b']){
      const response=list(organizationId,options);
      const expected=createApp(sampleSeed()).request({method:'GET',path:`/organizations/${organizationId}/projects`,token:'both',query:Object.fromEntries(Object.entries(options).map(([key,value])=>[key,String(value)]))});
      assert.deepEqual(response,expected);
      const reads=app.db.counters.projectLists;
      assert.deepEqual(list(organizationId,options),response);
      assert.equal(app.db.counters.projectLists,reads);
    }
  }
  assert.equal(cache.keys().length,variants.length*2);
  const otherKeys=cache.keys().filter(key=>key.startsWith(projectListPrefix('org-b')));
  const otherValues=otherKeys.map(key=>cache.get(key));
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:' Zulu '}}).status,200);
  assert.deepEqual(cache.keys(),otherKeys);
  assert.deepEqual(otherKeys.map(key=>cache.get(key)),otherValues);
  const reads=app.db.counters.projectLists;
  for(const options of variants)assert.equal(list('org-b',options).status,200);
  assert.equal(app.db.counters.projectLists,reads);
  const freshSeed=sampleSeed();
  freshSeed.projects.find(p=>p.id==='a1')!.name='Zulu';
  freshSeed.projects.find(p=>p.id==='a1')!.updatedAt++;
  const fresh=createApp(freshSeed);
  for(const options of variants){
    const expected=fresh.request({method:'GET',path:'/organizations/org-a/projects',token:'alice',query:Object.fromEntries(Object.entries(options).map(([key,value])=>[key,String(value)]))});
    assert.deepEqual(list('org-a',options),expected);
  }
  assert.equal(app.db.counters.projectLists,reads+variants.length);
});

test('organization key boundaries cannot collide or invalidate neighboring organizations',()=>{
  const options:ListOptions={page:1,pageSize:10,sort:'name',direction:'asc'};
  const ids=['org','org:a','org%3Aa','org/a'];
  assert.equal(new Set(ids.map(id=>projectListKey(id,options))).size,ids.length);
  const cache=createCache(),seed=sampleSeed();
  seed.projects[0].organizationId='org';
  seed.memberships.push({userId:'alice',organizationId:'org'});
  const app=createApp(seed,cache);
  for(const id of ids)cache.set(projectListKey(id,options),{organizationId:id});
  assert.equal(app.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'New'}}).status,200);
  assert.deepEqual(cache.keys(),ids.slice(1).map(id=>projectListKey(id,options)));
});
