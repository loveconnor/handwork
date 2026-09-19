import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/pagination.ts';
test('empty collection', () => assert.deepEqual(paginate([], 1, 5), []));
test('page beyond collection', () => assert.deepEqual(paginate([1, 2], 5, 3), []));
test('reject invalid page', () => assert.throws(() => paginate([1], 0, 3), RangeError));
test('reject invalid page size', () => assert.throws(() => paginate([1], 1, 0), RangeError));
