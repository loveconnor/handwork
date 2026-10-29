import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findTextMatches } from '../../lib/find-text.ts';

const found = (text, query) => findTextMatches(text, query).map(({ start, end }) => text.slice(start, end));

test('Unicode case expansion preserves original search offsets', () => {
  assert.deepEqual(findTextMatches('İZZ_AUDIT', 'ZZ_AUDIT'), [{ start: 1, end: 9 }]);
  assert.deepEqual(found('İstanbul İSTANBUL', 'stanbul'), ['stanbul', 'STANBUL']);
  assert.deepEqual(found('İstanbul', 'i'), ['İ']);
  assert.deepEqual(found('İstanbul', 'İSTANBUL'), ['İstanbul']);
});

test('search offsets stay in UTF-16 across emoji, combining marks, and contextual case folding', () => {
  assert.deepEqual(findTextMatches('😀İZZ', 'zz'), [{ start: 3, end: 5 }]);
  assert.deepEqual(found('😀 Example 😀', '😀'), ['😀', '😀']);
  assert.deepEqual(found('ΟΣ', 'ΟΣ'), ['ΟΣ']);
  assert.deepEqual(found('A\u0301 BC', 'bc'), ['BC']);
});

test('expansion boundaries map partial folds, multiple expansions, and intervening UTF-16 text', () => {
  assert.deepEqual(findTextMatches('İİ', 'i'), [{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  assert.deepEqual(findTextMatches('İİ', '\u0307'), [{ start: 0, end: 1 }, { start: 1, end: 2 }]);
  assert.deepEqual(findTextMatches('İİİ', '\u0307i'), [{ start: 0, end: 2 }]);
  assert.deepEqual(findTextMatches('İ😀ΟΣ İ😀ΟΣ', '😀ΟΣ'), [{ start: 1, end: 5 }, { start: 7, end: 11 }]);
  assert.deepEqual(findTextMatches('xİ😀İz', 'z'), [{ start: 5, end: 6 }]);
  assert.deepEqual(findTextMatches('İ', '\u0307x'), []);
  assert.deepEqual(findTextMatches('İİ', 'i', 1), [{ start: 0, end: 1 }]);
});

test('same-length casing preserves native UTF-16 boundaries and contextual sigma', () => {
  assert.deepEqual(findTextMatches('😀😀', '\ude00'), [{ start: 1, end: 2 }, { start: 3, end: 4 }]);
  assert.deepEqual(findTextMatches('İ😀', '\ude00'), [{ start: 2, end: 3 }]);
  assert.deepEqual(findTextMatches('𐐀 𐐨', '𐐨'), [{ start: 0, end: 2 }, { start: 3, end: 5 }]);
  assert.deepEqual(findTextMatches('ΟΣ ΟΣΑ', 'ος'), [{ start: 0, end: 2 }]);
  assert.deepEqual(findTextMatches('İΟΣ ΟΣΑ', 'ος'), [{ start: 1, end: 3 }]);
  for (const limit of [0, -1]) assert.deepEqual(findTextMatches('İ text', 'text', limit), []);
});

test('ordinary search remains case-insensitive, non-overlapping, bounded, and block-separated', () => {
  assert.deepEqual(found('Hello hello HELLO', 'hello'), ['Hello', 'hello', 'HELLO']);
  assert.deepEqual(findTextMatches('aaaa', 'aa'), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  assert.equal(findTextMatches('a a a', 'a', 2).length, 2);
  for (const [text, query] of [['text', ''], ['', 'text'], ['first\nsecond', 'firstsecond']]) assert.deepEqual(findTextMatches(text, query), []);
});
