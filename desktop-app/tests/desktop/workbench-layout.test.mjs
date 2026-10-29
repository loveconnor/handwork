import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyLayout, splitPane, removePane, setRatio, openInEditor, closeFile, paneIds, filesInUse } from '../../lib/workbench-layout.ts';

const terminal = id => ({ id, kind: 'terminal' });

test('splits place panes beside or below, and closing one gives its space to the sibling', () => {
  let layout = emptyLayout();
  const editor = layout.focused;
  layout = splitPane(layout, editor, terminal('t1'), 'column', 0.65);
  assert.equal(layout.focused, 't1');
  assert.deepEqual(paneIds(layout.root), [editor, 't1']);
  assert.equal(layout.root.direction, 'column');
  layout = splitPane(layout, 't1', terminal('t2'), 'row');
  assert.deepEqual(paneIds(layout.root), [editor, 't1', 't2']);
  layout = removePane(layout, 't1');
  assert.deepEqual(paneIds(layout.root), [editor, 't2']);
  assert.equal(layout.panes.t1, undefined);
  layout = removePane(removePane(layout, 't2'), editor);
  assert.equal(paneIds(layout.root).length, 1, 'closing the last pane leaves one empty editor');
  assert.equal(layout.panes[layout.focused].kind, 'editor');
});

test('dividers stay within reach', () => {
  const fresh = emptyLayout();
  const layout = splitPane(fresh, fresh.focused, terminal('t'), 'row');
  assert.equal(setRatio(layout, layout.root.id, 0.99).root.ratio, 0.85);
  assert.equal(setRatio(layout, layout.root.id, -1).root.ratio, 0.15);
});

test('files open in the focused editor, or a new editor above when only terminals are left', () => {
  let layout = emptyLayout();
  const editor = layout.focused;
  layout = openInEditor(layout, 'src/a.ts');
  layout = openInEditor(layout, 'src/b.ts');
  layout = openInEditor(layout, 'src/a.ts');
  assert.deepEqual(layout.panes[editor].files, ['src/a.ts', 'src/b.ts']);
  assert.equal(layout.panes[editor].active, 'src/a.ts');
  layout = closeFile(layout, editor, 'src/a.ts');
  assert.equal(layout.panes[editor].active, 'src/b.ts', 'the neighbour takes over');
  // Only a terminal remains: opening a file adds an editor above it.
  const start = emptyLayout();
  let terminalOnly = splitPane(start, start.focused, terminal('t'), 'column');
  terminalOnly = removePane(terminalOnly, paneIds(terminalOnly.root)[0]);
  terminalOnly = openInEditor(terminalOnly, 'README.md');
  const [top, bottom] = paneIds(terminalOnly.root);
  assert.equal(terminalOnly.panes[top].kind, 'editor');
  assert.equal(bottom, 't');
  assert.deepEqual([...filesInUse(terminalOnly)], ['README.md']);
});
