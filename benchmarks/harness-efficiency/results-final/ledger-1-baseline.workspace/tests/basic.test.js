import test from 'node:test';import assert from 'node:assert/strict';import {createStore} from '../src/store.js';import {transfer} from '../src/transfer.js';
test('transfer',()=>{const s=createStore([['a:x',20],['a:y',5]]);assert.deepEqual(transfer(s,{tenant:'a',key:'k',from:'x',to:'y',amount:3}),{from:'x',to:'y',amount:3});assert.equal(s.accounts.get('a:x'),17);});
