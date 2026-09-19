import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const { createApp } = await import(pathToFileURL(`${root}/src/app.ts`));
const { sampleSeed } = await import(pathToFileURL(`${root}/src/seed.ts`));
const { createCache } = await import(pathToFileURL(`${root}/src/cache/project-cache.ts`));
const checks = [];
function check(name, fn) { try { fn(); checks.push({name, pass:true}); } catch (e) { checks.push({name,pass:false,error:e.message}); } }
const list=(a, org, query={}, token='both')=>a.request({method:'GET',path:`/organizations/${encodeURIComponent(org)}/projects`,token,query});
const patch=(a,id,token='alice',body={name:'Updated'})=>a.request({method:'PATCH',path:`/projects/${id}`,token,body});
const read=(a,id,token='alice')=>a.request({method:'GET',path:`/projects/${id}`,token});
const forbidden={status:403,body:{error:'forbidden'}};
check('actual owner read authorization and status conventions',()=>{
 const a=createApp(sampleSeed()); assert.equal(read(a,'a1').status,200); assert.deepEqual(read(a,'b1'),forbidden);
 assert.equal(read(a,'missing').status,404); assert.equal(read(a,'a1','invalid').status,401);
 assert.deepEqual(a.request({method:'GET',path:'/projects/b1',token:'alice',query:{organizationId:'org-a'}}),forbidden);
});
check('unauthorized updates preserve storage and warmed entries',()=>{
 const c=createCache(),a=createApp(sampleSeed(),c);list(a,'org-b');
 const before=JSON.stringify([...a.db.projects]);const entries=c.keys().map(k=>[k,c.get(k)]);
 assert.deepEqual(patch(a,'b1','alice',{name:'hacked',organizationId:'org-a'}),forbidden);
 assert.equal(JSON.stringify([...a.db.projects]),before);assert.deepEqual(c.keys().map(k=>[k,c.get(k)]),entries);
});
check('list authorization including warm cache and revocation',()=>{
 const a=createApp(sampleSeed());list(a,'org-b');assert.deepEqual(list(a,'org-b',{},'alice'),forbidden);
 list(a,'org-a',{},'alice');a.db.memberships.delete(JSON.stringify(['alice','org-a']));assert.deepEqual(list(a,'org-a',{},'alice'),forbidden);
});
check('organizations have distinct lists with a dual member',()=>{
 const a=createApp(sampleSeed());assert.deepEqual(list(a,'org-a').body.items.map(p=>p.id),['a1','a2','a3']);assert.deepEqual(list(a,'org-b').body.items.map(p=>p.id),['b1','b2','b3']);
});
const variants=[];for(const sort of ['name','updatedAt'])for(const direction of ['asc','desc'])for(const pageSize of ['1','2','10'])for(const page of ['1','2'])variants.push({sort,direction,pageSize,page});
function expected(seed,org,q){const rows=seed.projects.filter(p=>p.organizationId===org).map(p=>({...p}));rows.sort((a,b)=>((q.sort==='name'?a.name.localeCompare(b.name):a.updatedAt-b.updatedAt)||a.id.localeCompare(b.id))*(q.direction==='asc'?1:-1));return {items:rows.slice((+q.page-1)*+q.pageSize,+q.page*+q.pageSize),total:rows.length,page:+q.page,pageSize:+q.pageSize,sort:q.sort,direction:q.direction};}
check('all pagination and sorting combinations remain distinct',()=>{
 const seed=sampleSeed(),a=createApp(seed);for(const org of ['org-a','org-b'])for(const q of variants)assert.deepEqual(list(a,org,q),{status:200,body:expected(seed,org,q)});
});
check('updates invalidate every own list variant while preserving other caches',()=>{
 const seed=sampleSeed(),a=createApp(seed);for(const org of ['org-a','org-b'])for(const q of variants)list(a,org,q);
 const n=a.db.counters.projectLists; assert.equal(patch(a,'a1','alice',{name:'Zulu'}).status,200);
 for(const q of variants)assert.deepEqual(list(a,'org-b',q).body,expected(seed,'org-b',q));assert.equal(a.db.counters.projectLists,n);
 const changed=sampleSeed();changed.projects.find(p=>p.id==='a1').name='Zulu';changed.projects.find(p=>p.id==='a1').updatedAt++;
 for(const q of variants)assert.deepEqual(list(a,'org-a',q).body,expected(changed,'org-a',q));
});
check('caching remains enabled and repeated lists skip repository',()=>{const a=createApp(sampleSeed());list(a,'org-a');const n=a.db.counters.projectLists;list(a,'org-a');assert.equal(a.db.counters.projectLists,n);});
check('opaque organization prefixes do not collide during invalidation',()=>{
 const seed=sampleSeed();for(const id of ['org-a:child','org-a-extra','x:y']){seed.organizations.push({id,name:id});seed.memberships.push({userId:'both',organizationId:id});seed.projects.push({id:`p-${id}`,organizationId:id,name:id,updatedAt:1});}
 const a=createApp(seed);for(const org of seed.organizations)list(a,org.id);patch(a,'a1');const n=a.db.counters.projectLists;
 for(const org of seed.organizations.filter(o=>o.id!=='org-a'))assert.deepEqual(list(a,org.id).body.items.map(p=>p.organizationId),seed.projects.filter(p=>p.organizationId===org.id).sort((a,b)=>a.name.localeCompare(b.name)).map(p=>p.organizationId));
 assert.equal(a.db.counters.projectLists,n);
});
console.log(JSON.stringify(checks));process.exitCode=checks.every(c=>c.pass)?0:1;
