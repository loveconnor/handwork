import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { sampleSeed } from '../src/seed.ts';
test('health and profile',()=>{const a=createApp(sampleSeed());assert.deepEqual(a.request({method:'GET',path:'/health'}).body,{status:'ok'});assert.equal((a.request({method:'GET',path:'/me',token:'alice'}).body as any).id,'alice');});
test('organizations scoped to user',()=>{const a=createApp(sampleSeed());assert.deepEqual((a.request({method:'GET',path:'/organizations',token:'alice'}).body as any).items.map((o:any)=>o.id),['org-a']);});
test('logout revokes session',()=>{const a=createApp(sampleSeed());assert.equal(a.request({method:'DELETE',path:'/session',token:'alice'}).status,204);assert.equal(a.request({method:'GET',path:'/me',token:'alice'}).status,401);});
