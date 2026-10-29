import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { draftKey, splitDrafts } from '../../lib/draft-recovery.ts';
import { validateArguments } from '../../electron/ipc.mjs';

const file = text => ({ name: 'notes.txt', mimeType: 'text/plain', size: text.length, text });

test('draft identity changes for equal-sized replacement files and in-place payload changes', () => {
  const original = file('AAAA');
  const before = draftKey('message', [original]);
  assert.equal(draftKey('message', [original]), before);
  assert.notEqual(draftKey('message', [file('BBBB')]), before);
  original.text = 'CCCC';
  assert.notEqual(draftKey('message', [original]), before);
  const binary = { name: 'image.png', mimeType: 'image/png', size: 3, data: 'QUFB' };
  const first = draftKey('', [binary]);
  binary.data = 'QkJC';
  assert.notEqual(draftKey('', [binary]), first);
  const contentChanged = draftKey('', [binary]);
  binary.uri = 'file:///picked/image.png';
  assert.notEqual(draftKey('', [binary]), contentChanged);
});

test('removing and reattaching a replacement during the debounce interval cannot reuse the old key', () => {
  const saved = draftKey('draft', [file('AAAA')]);
  assert.notEqual(draftKey('draft', []), saved);
  assert.notEqual(draftKey('draft', [file('BBBB')]), saved);
  assert.equal(draftKey('', []), '\u0000');
});

test('startup retains every orphan and preserves draft order and attachments', () => {
  const entries = ['known', 'orphan-one', 'orphan-two'].map((id, index) => ({ id, text: id, files: [file(String(index))], updatedAt: index }));
  const recovered = splitDrafts(entries, new Set(['known']));
  assert.deepEqual(recovered.known, [entries[0]]);
  assert.deepEqual(recovered.orphans, entries.slice(1));
  assert.equal(entries.length, 3);
  const source = readFileSync(new URL('../../components/site/HandworkHarness.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /removeDrafts\?\.\(orphans\)/);
  assert.match(source, /await flushDraft\(\);\s+const result = await api\.moveDraft\(entry\.id, sessionId\)/);
  assert.match(source, /Saved unsent messages/);
});

test('draft recovery feedback stays with the composer instead of becoming transcript content', () => {
  const source = readFileSync(new URL('../../components/site/HandworkHarness.tsx', import.meta.url), 'utf8');
  const composer = source.slice(source.indexOf('  const composer ='), source.indexOf('  return <main'));
  assert.match(composer, /className="handwork-draft-recovery"/);
  assert.match(composer, /'Draft restored'/);
  assert.match(composer, /variant="ghost"/);
  assert.match(source, /if \(restoredDraft && !draftRestored\) setRestoredDraft\(undefined\)/);
  assert.doesNotMatch(source, /Restored your unsent message|Other saved messages remain available above/);
  const css = readFileSync(new URL('../../desktop/desktop.css', import.meta.url), 'utf8');
  assert.match(css, /\.handwork-draft-recovery \{[^}]*font-size: calc\(var\(--hui-font-size-regular, 14px\) - 2px\)/);
});

test('draft recovery IPC validates both IDs and is exposed by the preload', () => {
  assert.doesNotThrow(() => validateArguments('moveDraft', ['orphan-one', 'new-chat']));
  for (const args of [['one'], ['', 'two'], ['../outside', 'two'], ['one', null], ['one', '__proto__']]) assert.throws(() => validateArguments('moveDraft', args));
  const preload = readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /'moveDraft'/);
});
