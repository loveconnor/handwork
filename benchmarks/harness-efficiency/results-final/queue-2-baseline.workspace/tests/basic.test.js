import test from 'node:test';import assert from 'node:assert/strict';import {mapLimit} from '../src/map.js';
test('empty',async()=>assert.deepEqual(await mapLimit([],2,x=>x),[]));
test('single',async()=>assert.deepEqual(await mapLimit([2],1,x=>x*2),[{status:'fulfilled',value:4}]));
