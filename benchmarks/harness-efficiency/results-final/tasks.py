"""Predeclared held-out behavioral tasks. Never used to tune runtime changes."""
COMMON='Fix the bug described in README.md. Inspect the implementation, preserve the documented API, and run the existing tests. Do not modify tests, README.md, package files, or install dependencies. Summarize changes and verification.'
TASKS={}
TASKS['queue']={
 'description':'Bounded concurrent execution must preserve input order, settle failures without hanging, and never launch more than limit workers. mapLimit(items, limit, fn) returns Promise<Array<{status:"fulfilled",value}|{status:"rejected",reason}>>. Invalid limits (not positive integers) reject with RangeError before any work. A synchronous throw counts as a rejected item; it must not stop remaining work. Empty input resolves [].',
 'files':{
 'src/map.js':'''import { execute } from './worker.js';
export async function mapLimit(items, limit, fn) {
  if (limit < 1) throw new RangeError('limit');
  const results = [];
  await Promise.all(items.map(async (item, index) => {
    results.push(await execute(fn, item, index));
  }));
  return results;
}
''',
 'src/worker.js':'''export async function execute(fn, item, index) {
  return {status:'fulfilled', value:await fn(item,index)};
}
''',
 'tests/basic.test.js':'''import test from 'node:test';import assert from 'node:assert/strict';import {mapLimit} from '../src/map.js';
test('empty',async()=>assert.deepEqual(await mapLimit([],2,x=>x),[]));
test('single',async()=>assert.deepEqual(await mapLimit([2],1,x=>x*2),[{status:'fulfilled',value:4}]));
'''},
 'gold':{'src/map.js':'''import {execute} from './worker.js';
export async function mapLimit(items,limit,fn){
 if(!Number.isInteger(limit)||limit<1)throw new RangeError('limit');
 const results=new Array(items.length);let next=0;
 async function worker(){while(next<items.length){const i=next++;results[i]=await execute(fn,items[i],i);}}
 await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>worker()));return results;
}
''','src/worker.js':'''export async function execute(fn,item,index){try{return {status:'fulfilled',value:await fn(item,index)}}catch(reason){return {status:'rejected',reason}}}
'''},
 'verify':'''const {mapLimit}=await load('map.js');
await check('bounded overlap and order',async()=>{let active=0,peak=0;const r=await mapLimit([30,5,15,1],2,async(ms,i)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,ms));active--;return i});assert.equal(peak,2);assert.deepEqual(r.map(x=>x.value),[0,1,2,3]);});
await check('sync and async failure settle and continue',async()=>{const r=await mapLimit([0,1,2,3],2,x=>{if(x===0)throw Error('sync');if(x===1)return Promise.reject(Error('async'));return x;});assert.deepEqual(r.map(x=>x.status),['rejected','rejected','fulfilled','fulfilled']);assert.equal(r[0].reason.message,'sync');assert.equal(r[3].value,3);});
await check('invalid limits do not start work',async()=>{for(const n of [0,-1,1.5,NaN,Infinity]){let calls=0;await assert.rejects(()=>mapLimit([1],n,()=>calls++),RangeError);assert.equal(calls,0);}});
await check('sequential limit and immutable input',async()=>{const input=Object.freeze([3,2,1]);let active=0;const r=await mapLimit(input,1,async x=>{assert.equal(active++,0);await Promise.resolve();active--;return x});assert.deepEqual(r.map(x=>x.value),[3,2,1]);});
await check('empty and excess capacity',async()=>{assert.deepEqual(await mapLimit([],3,x=>x),[]);assert.equal((await mapLimit([1],99,x=>x))[0].value,1);});
'''}
TASKS['ledger']={
 'description':'transfer(store,{tenant,key,from,to,amount}) moves integer cents atomically. store.accounts is a Map keyed by `${tenant}:${accountId}` and store.receipts is a Map. Missing accounts reject; amount must be a positive safe integer, source and target distinct, funds sufficient. On ANY rejection neither Map may change. Idempotency is scoped to tenant and key: an identical successful replay returns the prior receipt without moving money; a changed payload under that key rejects. Different tenants using the same key are independent. Result is {from,to,amount}. Account balances must remain safe integers. transfer is synchronous.',
 'files':{
 'src/store.js':'''export function createStore(entries){return {accounts:new Map(entries),receipts:new Map()};}
''',
 'src/transfer.js':'''import {receiptKey} from './keys.js';
export function transfer(store,req){
 const key=receiptKey(req);if(store.receipts.has(key))return store.receipts.get(key);
 const a=`${req.tenant}:${req.from}`,b=`${req.tenant}:${req.to}`;
 const before=store.accounts.get(a);
 if(before<req.amount)throw Error('insufficient funds');
 store.accounts.set(a,before-req.amount);
 if(!store.accounts.has(b))throw Error('missing target');
 store.accounts.set(b,store.accounts.get(b)+req.amount);
 const receipt={from:req.from,to:req.to,amount:req.amount};store.receipts.set(key,receipt);return receipt;
}
''',
 'src/keys.js':'''export function receiptKey(req){return req.key;}
''',
 'tests/basic.test.js':'''import test from 'node:test';import assert from 'node:assert/strict';import {createStore} from '../src/store.js';import {transfer} from '../src/transfer.js';
test('transfer',()=>{const s=createStore([['a:x',20],['a:y',5]]);assert.deepEqual(transfer(s,{tenant:'a',key:'k',from:'x',to:'y',amount:3}),{from:'x',to:'y',amount:3});assert.equal(s.accounts.get('a:x'),17);});
'''},
 'gold':{'src/keys.js':'''export function receiptKey(req){return JSON.stringify([req.tenant,req.key]);}
''','src/transfer.js':'''import {receiptKey} from './keys.js';
export function transfer(store,req){
 const key=receiptKey(req),old=store.receipts.get(key);
 if(old){if(old.from!==req.from||old.to!==req.to||old.amount!==req.amount)throw Error('conflict');return old;}
 if(!Number.isSafeInteger(req.amount)||req.amount<=0||req.from===req.to)throw Error('invalid');
 const a=`${req.tenant}:${req.from}`,b=`${req.tenant}:${req.to}`;
 if(!store.accounts.has(a)||!store.accounts.has(b))throw Error('missing');
 const source=store.accounts.get(a),target=store.accounts.get(b);
 if(!Number.isSafeInteger(source)||!Number.isSafeInteger(target)||source<req.amount||!Number.isSafeInteger(target+req.amount))throw Error('funds');
 const receipt={from:req.from,to:req.to,amount:req.amount};
 store.accounts.set(a,source-req.amount);store.accounts.set(b,target+req.amount);store.receipts.set(key,receipt);return receipt;
}
'''},
 'verify':'''const {transfer}=await load('transfer.js');const {createStore}=await load('store.js');
const make=()=>createStore([['a:x',100],['a:y',20],['b:x',80],['b:y',0]]);const req={tenant:'a',key:'k',from:'x',to:'y',amount:10};
const snapshot=s=>JSON.stringify([[...s.accounts],[...s.receipts]]);
await check('tenant isolated idempotency',()=>{const s=make();transfer(s,req);transfer(s,{...req,tenant:'b'});assert.equal(s.accounts.get('b:x'),70);assert.equal(s.accounts.get('a:x'),90);});
await check('same replay is stable changed payload rejected',()=>{const s=make();const first=transfer(s,req);const before=snapshot(s);assert.deepEqual(transfer(s,req),first);assert.throws(()=>transfer(s,{...req,amount:11}));assert.equal(snapshot(s),before);});
await check('missing source and target atomic',()=>{for(const change of [{from:'missing'},{to:'missing'}]){const s=make(),before=snapshot(s);assert.throws(()=>transfer(s,{...req,...change}));assert.equal(snapshot(s),before);}});
await check('invalid amounts atomic',()=>{for(const amount of [0,-1,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){const s=make(),before=snapshot(s);assert.throws(()=>transfer(s,{...req,amount}));assert.equal(snapshot(s),before);}});
await check('self transfer and overdraft atomic',()=>{for(const change of [{to:'x'},{amount:101}]){const s=make(),before=snapshot(s);assert.throws(()=>transfer(s,{...req,...change}));assert.equal(snapshot(s),before);}});
await check('balance overflow atomic',()=>{const s=make();s.accounts.set('a:y',Number.MAX_SAFE_INTEGER);const before=snapshot(s);assert.throws(()=>transfer(s,req));assert.equal(snapshot(s),before);});
await check('independent keys and conservation',()=>{const s=make();for(let i=0;i<10;i++)transfer(s,{...req,key:String(i),amount:1});assert.equal(s.accounts.get('a:x'),90);assert.equal(s.accounts.get('a:y'),30);});
'''}
TASKS['stream']={
 'description':'createDecoder(onValue,onError) consumes string chunks containing newline-delimited JSON. push(chunk) buffers incomplete lines, supports CRLF split across chunks and ignores blank lines. Each valid JSON value is emitted once, including null/false/0. Malformed complete lines call onError(error,lineNumber) and processing continues. Line numbers start at 1 and include blank lines. end() processes a final nonempty unterminated line exactly once, is idempotent, and closes the decoder. push after end throws. Callback exceptions propagate and must not be misclassified as JSON errors. API is synchronous. Fix state handling without dependencies.',
 'files':{
 'src/decoder.js':'''import {parseLine} from './parse.js';
export function createDecoder(onValue,onError){let line=0;return {
 push(chunk){for(const text of chunk.split('\\n')){line++;parseLine(text,line,onValue,onError);}},
 end(){}
};}
''',
 'src/parse.js':'''export function parseLine(text,line,onValue,onError){if(!text.trim())return;try{const value=JSON.parse(text);if(value)onValue(value);}catch(error){onError(error,line);}}
''',
 'tests/basic.test.js':'''import test from 'node:test';import assert from 'node:assert/strict';import {createDecoder} from '../src/decoder.js';
test('complete record',()=>{const values=[];const d=createDecoder(x=>values.push(x),()=>{});d.push('{"a":1}\\n');d.end();assert.deepEqual(values,[{a:1}]);});
'''},
 'gold':{'src/decoder.js':'''import {parseLine} from './parse.js';
export function createDecoder(onValue,onError){let line=0,buffer='',closed=false;return {
 push(chunk){if(closed)throw Error('closed');buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))!==-1){const text=buffer.slice(0,i);buffer=buffer.slice(i+1);parseLine(text,++line,onValue,onError);}},
 end(){if(closed)return;closed=true;const text=buffer;buffer='';if(text.length)parseLine(text,++line,onValue,onError);}
};}
''','src/parse.js':'''export function parseLine(text,line,onValue,onError){if(!text.trim())return;let value;try{value=JSON.parse(text);}catch(error){onError(error,line);return;}onValue(value);}
'''},
 'verify':'''const {createDecoder}=await load('decoder.js');
await check('every split boundary preserves unicode and escaped strings',()=>{const source='{"text":"hello😀\\\\nworld"}\\r\\n0\\nfalse\\nnull';for(let i=0;i<=source.length;i++){const values=[],errors=[];const d=createDecoder(v=>values.push(v),(e,n)=>errors.push(n));d.push(source.slice(0,i));d.push(source.slice(i));d.end();assert.deepEqual(values,[{text:'hello😀\\nworld'},0,false,null]);assert.deepEqual(errors,[]);}});
await check('malformed record recovery line numbering',()=>{const values=[],errors=[];const d=createDecoder(v=>values.push(v),(e,n)=>{assert.ok(e instanceof Error);errors.push(n)});d.push('\\n{"x":');d.push('1}\\nnot-json\\n\\n2\\n');d.end();assert.deepEqual(values,[{x:1},2]);assert.deepEqual(errors,[3]);});
await check('unterminated final record exactly once and close',()=>{const v=[];const d=createDecoder(x=>v.push(x),()=>{});d.push('12');assert.deepEqual(v,[]);d.end();d.end();assert.deepEqual(v,[12]);assert.throws(()=>d.push('3'));});
await check('callbacks errors propagate without parse misclassification',()=>{let errors=0;const boom=Error('callback');const d=createDecoder(()=>{throw boom},()=>errors++);assert.throws(()=>d.push('1\\n'),e=>e===boom);assert.equal(errors,0);});
await check('blank chunks and empty close',()=>{const v=[],e=[];const d=createDecoder(x=>v.push(x),(x,n)=>e.push(n));d.push('');d.push('  \\r');d.push('\\n');d.end();assert.deepEqual(v,[]);assert.deepEqual(e,[]);});
'''}

PREAMBLE='''import assert from 'node:assert/strict';import path from 'node:path';import {pathToFileURL} from 'node:url';
const root=process.argv[2];const load=name=>import(pathToFileURL(path.join(root,'src',name)).href);const checks=[];
async function check(name,fn){try{await fn();checks.push({name,pass:true});}catch(e){checks.push({name,pass:false,error:String(e)});}}
'''
TAIL="console.log(JSON.stringify(checks));process.exitCode=checks.every(c=>c.pass)?0:1;\n"
