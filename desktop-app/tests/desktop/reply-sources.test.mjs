import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replySources, sourceUrl } from '../../lib/reply-sources.ts';

test('source lists become deduplicated titled sources while keeping exact URLs', () => {
  const text = 'Visit the park.\n\nSources:\n- [Park](https://ohiodnr.gov/park?utm_source=openai)\n- [Map](https://ohiodnr.gov/map.pdf)\n- [Park](https://ohiodnr.gov/park?utm_source=openai)';
  const result = replySources(text);
  assert.equal(result.markdown, 'Visit the park.');
  assert.deepEqual(result.sources, [
    { title: 'Park', domain: 'ohiodnr.gov', href: 'https://ohiodnr.gov/park?utm_source=openai' },
    { title: 'Map', domain: 'ohiodnr.gov', href: 'https://ohiodnr.gov/map.pdf' },
  ]);
});

test('inline and reference citations are collected without removing surrounding prose', () => {
  const text = 'Read [Park][park] and https://example.com/map.\n\n[park]: https://example.com/park';
  const result = replySources(text);
  assert.equal(result.markdown, text);
  assert.deepEqual(result.sources.map(source => source.title), ['Park', 'example.com']);
});

test('code examples and source descriptions stay intact', () => {
  const code = '```md\nSources:\n- [Example](https://example.com)\n```';
  assert.deepEqual(replySources(code), { markdown: code, sources: [] });
  const description = '## Sources\n- [Park](https://example.com) — includes trail closures.\n\nNext steps.';
  assert.equal(replySources(description).markdown, description);
});

test('only HTTP and HTTPS links without embedded credentials become citations', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'https://user:pass@example.com', '/local']) {
    assert.equal(sourceUrl(url), null);
  }
  assert.equal(sourceUrl('https://example.com/path'), 'https://example.com/path');
  assert.deepEqual(replySources('[local](file:///tmp/test)').sources, []);
});
