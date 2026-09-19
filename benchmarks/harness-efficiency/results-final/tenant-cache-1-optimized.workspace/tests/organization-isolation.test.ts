import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
import { membershipRepository } from '../src/db/membership-repository.ts';
import { projectRepository } from '../src/db/project-repository.ts';
import type { ListOptions } from '../src/types.ts';

const forbidden={status:403,body:{error:'forbidden'}};

test('project authorization uses the stored owner and rejects writes without side effects',()=>{
  const a=createApp(sampleSeed());
  a.request({method:'GET',path:'/organizations/org-b/projects',token:'bob'});
  const before=structuredClone([...a.db.projects]);
  const keys=a.cache.keys();
  for(const method of ['GET','PATCH']) {
    assert.deepEqual(a.request({method,path:'/projects/b1',token:'alice',query:{organizationId:'org-a'},body:{name:'Stolen',organizationId:'org-a'}}),forbidden);
    assert.equal(a.request({method,path:'/projects/missing',token:'alice',body:{name:'New'}}).status,404);
    assert.equal(a.request({method,path:'/projects/b1',body:{name:'New'}}).status,401);
  }
  assert.deepEqual([...a.db.projects],before);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(a.cache.keys(),keys);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/b1',token:'alice',body:{name:''}}),forbidden);
  const updated=a.request({method:'PATCH',path:'/projects/b1',token:'both',body:{name:' New ',organizationId:'org-a'}});
  assert.equal(updated.status,200);
  assert.equal((updated.body as any).organizationId,'org-b');
  assert.equal((updated.body as any).name,'New');
});

test('lists check membership before cache hits, including after revocation',()=>{
  const a=createApp(sampleSeed());
  const path='/organizations/org-a/projects';
  assert.deepEqual(a.request({method:'GET',path,token:'bob'}),forbidden);
  assert.equal(a.db.counters.projectLists,0);
  assert.equal(a.cache.keys().length,0);
  assert.equal(a.request({method:'GET',path,token:'alice'}).status,200);
  assert.deepEqual(a.request({method:'GET',path,token:'bob'}),forbidden);
  membershipRepository(a.db).revoke('alice','org-a');
  const keys=a.cache.keys();
  assert.deepEqual(a.request({method:'GET',path,token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'GET',path:'/projects/a1',token:'alice'}),forbidden);
  assert.deepEqual(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'No'}}),forbidden);
  assert.equal(a.request({method:'GET',path,token:'both'}).status,200);
  assert.equal(a.db.counters.projectLists,1);
  assert.equal(a.db.counters.projectUpdates,0);
  assert.deepEqual(a.cache.keys(),keys);
});

test('cache isolates all list options and invalidates only the owning organization',()=>{
  const seed=sampleSeed();
  // Include shared prefixes and punctuation to exercise exact organization grouping.
  const ids=['org-a','org-a:child','org-a" :\\child'];
  for(const [i,id] of ids.entries()) {
    if(i===0)continue;
    seed.organizations.push({id,name:id});
    seed.memberships.push({userId:'both',organizationId:id});
    seed.projects.push({id:`extra-${i}`,organizationId:id,name:'Extra',updatedAt:1});
  }
  ids.push('org-b');
  const a=createApp(seed);
  const reference=createApp(seed);
  const variants:ListOptions[]=[];
  for(const page of [1,2])for(const pageSize of [1,2])for(const sort of ['name','updatedAt'] as const)for(const direction of ['asc','desc'] as const)variants.push({page,pageSize,sort,direction});
  const list=(id:string,options:ListOptions)=>a.request({method:'GET',path:`/organizations/${encodeURIComponent(id)}/projects`,token:'both',query:Object.fromEntries(Object.entries(options).map(([k,v])=>[k,String(v)]))});
  for(const id of ids)for(const options of variants) {
    const result=list(id,options);
    assert.equal(result.status,200);
    assert.deepEqual(result.body,projectRepository(reference.db).list(id,options));
    assert.deepEqual(list(id,options),result);
  }
  const count=ids.length*variants.length;
  assert.equal(a.db.counters.projectLists,count);
  assert.equal(a.cache.keys().length,count);
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:''}}).status,400);
  assert.equal(a.cache.keys().length,count);
  assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'Zulu'}}).status,200);
  projectRepository(reference.db).update('a1','Zulu');
  assert.equal(a.cache.keys().length,count-variants.length);
  for(const id of ids.slice(1))for(const options of variants) {
    assert.deepEqual(list(id,options).body,projectRepository(reference.db).list(id,options));
  }
  assert.equal(a.db.counters.projectLists,count);
  for(const options of variants) {
    const result=list('org-a',options);
    assert.deepEqual(result.body,projectRepository(reference.db).list('org-a',options));
    assert.deepEqual(list('org-a',options),result);
  }
  assert.equal(a.db.counters.projectLists,count+variants.length);
});
