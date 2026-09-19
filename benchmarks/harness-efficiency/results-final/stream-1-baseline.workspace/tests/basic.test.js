import test from 'node:test';import assert from 'node:assert/strict';import {createDecoder} from '../src/decoder.js';
test('complete record',()=>{const values=[];const d=createDecoder(x=>values.push(x),()=>{});d.push('{"a":1}\n');d.end();assert.deepEqual(values,[{a:1}]);});
