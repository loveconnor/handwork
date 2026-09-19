const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const [repo, port] = process.argv.slice(2);
const { Queue, Job } = require(path.join(repo, 'dist/cjs'));
const { createIORedisClient } = require(path.join(repo, 'dist/cjs/classes/ioredis-client'));
const Redis = require(path.join(repo, 'node_modules/ioredis'));
const raw = new Redis({ host: '127.0.0.1', port: Number(port), maxRetriesPerRequest: null });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { const end=Date.now()+10000; while(Date.now()<end) { const v=await fn(); if(v)return v; await sleep(10); } throw Error('State transition timed out'); }
async function actor(queueName,prefix,token) {
 const child=fork(path.join(__dirname,'actor.cjs'),[repo,port,queueName,prefix,token],{stdio:['ignore','ignore','pipe','ipc']});
 let id=0;const pending=new Map();let ready=false;let errors='';child.stderr.on('data',s=>errors+=s);
 child.on('message',r=>{if(r.ready)ready=true; if(pending.has(r.id)){pending.get(r.id)(r);pending.delete(r.id);}});
 await until(()=>{if(child.exitCode!==null)throw Error(errors);return ready;});
 return { child, async call(op) { const n=++id; return Promise.race([new Promise(resolve=>{pending.set(n,resolve);child.send({id:n,op});}),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Actor timeout '+op)),10000);t.unref();})]);}, async stop(){ if(child.exitCode===null && child.signalCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}} };
}
const checks=[];
async function test(name,fn) { try { await fn(); checks.push({name,pass:true}); } catch(e) {checks.push({name,pass:false,error:e.stack});} }
async function scenario(op,opts={},crash=false) {
 const prefix='audit-'+randomUUID();const queueName='recovery';const tokenA=randomUUID(),tokenB=randomUUID();const q=new Queue(queueName,{connection:createIORedisClient(raw),prefix});
 let a,b;
 try {
  const created=await q.add('work',{value:1},opts);const key=`${prefix}:${queueName}:${created.id}`;
  a=await actor(queueName,prefix,tokenA);assert.equal((await a.call('claim')).value,created.id);
  if(crash)await a.stop();
  await raw.pexpire(key+':lock',25);await until(async()=>!(await raw.exists(key+':lock')));
  if(op==='missing') { const r=await a.call('complete');assert.equal(r.ok,false);assert.match(r.error,/lock/i);return; }
  b=await actor(queueName,prefix,tokenB);assert.equal((await b.call('recover')).ok,true);
  await until(async()=>await created.getState()==='waiting');
  assert.equal((await b.call('claim')).value,created.id);assert.equal(await raw.get(key+':lock'),tokenB);
  const before=await raw.hgetall(key);const stream=`${prefix}:${queueName}:events`;const eventCount=await raw.xlen(stream);
  if(!crash) {
   const result=await a.call(op);
   if(op==='extend')assert.equal(result.value,0);
   else if(op==='extend-batch')assert.deepEqual(result.value,[created.id]);
   else {assert.equal(result.ok,false);assert.match(result.error,/lock/i);}
   assert.equal(await raw.get(key+':lock'),tokenB,'Stale operation changed the new owner lock');
   assert.equal(await created.getState(),'active');
   const after=await raw.hgetall(key);
   for(const field of ['atm','ats','failedReason','returnvalue','finishedOn','delay'])assert.equal(after[field],before[field],field+' changed on rejected operation');
   assert.equal(await raw.xlen(stream),eventCount,'Rejected operation emitted an event');
  }
  assert.equal((await b.call('extend')).value,1,'Current owner cannot renew');
  assert.deepEqual((await b.call('extend-batch')).value,[],'Current owner cannot batch-renew');
  assert.equal((await b.call('complete')).ok,true,'Current owner cannot complete');
  assert.equal(await created.getState(),'completed');
  const finished=await Job.fromId(q,created.id);assert.equal(finished.returnvalue,'owner-result');
  const events=await raw.xrange(stream,'-','+');
  assert.equal(events.filter(([,v])=>{const o=Object.fromEntries(Array.from({length:v.length/2},(_,i)=>[v[i*2],v[i*2+1]]));return o.event==='completed'&&o.jobId===created.id;}).length,1);
 } finally {if(a)await a.stop();if(b)await b.stop();await q.close();const keys=await raw.keys(prefix+':*');if(keys.length)await raw.del(...keys);}
}
async function retryControl(delay) {
 const prefix='audit-'+randomUUID(),name='retries';const q=new Queue(name,{connection:createIORedisClient(raw),prefix});let a,b;
 try {
  const j=await q.add('work',{}, { attempts:2,...(delay?{backoff:{type:'fixed',delay}}:{}) });
  a=await actor(name,prefix,randomUUID());assert.equal((await a.call('claim')).value,j.id);
  assert.equal((await a.call('fail')).ok,true);
  assert.equal(await j.getState(),delay?'delayed':'waiting');
  await a.stop();
  b=await actor(name,prefix,randomUUID());
  await until(async()=>{const r=await b.call('claim');return r.value===j.id;});
  assert.equal((await b.call('fail')).ok,true);assert.equal(await j.getState(),'failed');
  assert.equal((await Job.fromId(q,j.id)).attemptsMade,2);
 } finally {if(a)await a.stop();if(b)await b.stop();await q.close();const keys=await raw.keys(prefix+':*');if(keys.length)await raw.del(...keys);}
}
(async()=>{
 await test('Expired lock cannot complete',()=>scenario('missing'));
 await test('Stale owner cannot complete after recovery',()=>scenario('complete'));
 await test('Stale owner cannot fail after recovery',()=>scenario('fail',{attempts:1}));
 await test('Stale owner cannot requeue an immediate retry',()=>scenario('fail',{attempts:3}));
 await test('Stale owner cannot schedule a delayed retry',()=>scenario('fail',{attempts:3,backoff:{type:'fixed',delay:1000}}));
 await test('Stale owner cannot renew a single lock',()=>scenario('extend'));
 await test('Stale owner cannot renew a batch of locks',()=>scenario('extend-batch'));
 await test('Killed worker is recovered by a new process',()=>scenario('complete',{},true));
 await test('Immediate retry limits survive worker restart',()=>retryControl(0));
 await test('Delayed retry limits survive worker restart',()=>retryControl(150));
 raw.disconnect();console.log(JSON.stringify(checks,null,2));process.exit(checks.every(c=>c.pass)?0:1);
})().catch(e=>{console.error(e);raw.disconnect();process.exit(2);});
