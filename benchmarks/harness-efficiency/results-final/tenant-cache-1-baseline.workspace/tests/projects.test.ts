import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
test('authenticated detail',()=>{const a=createApp(sampleSeed());assert.equal(a.request({method:'GET',path:'/projects/a1',token:'alice'}).status,200);});
test('authenticated list',()=>{const a=createApp(sampleSeed());const r=a.request({method:'GET',path:'/organizations/org-a/projects',token:'alice'});assert.equal(r.status,200);assert.equal((r.body as any).items.length,3);});
test('update then read',()=>{const a=createApp(sampleSeed());assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:'New'}}).status,200);assert.equal((a.request({method:'GET',path:'/projects/a1',token:'alice'}).body as any).name,'New');});
test('anonymous request rejected',()=>{const a=createApp(sampleSeed());assert.deepEqual(a.request({method:'GET',path:'/projects/a1'}),{status:401,body:{error:'unauthorized'}});});
test('invalid update rejected',()=>{const a=createApp(sampleSeed());assert.equal(a.request({method:'PATCH',path:'/projects/a1',token:'alice',body:{name:''}}).status,400);});
