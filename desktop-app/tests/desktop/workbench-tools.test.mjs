import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { matchPath, rankPaths } from '../../lib/fuzzy-path.ts';
import { addTerminalTab, closeTerminalTab, closeWithin, emptyLayout, movedPath, openInEditor, paneIds, readLayout, renameInLayout, restorableLayout, splitPane, terminalPane, updateTerminalTab } from '../../lib/workbench-layout.ts';
import { isLintable, syntaxDiagnostics } from '../../components/site/editorLint.ts';

const files = ['lib/workbench-layout.ts', 'components/site/HandworkWorkbench.tsx', 'tests/desktop/workbench-layout.test.mjs', 'lib/fuzzy-path.ts', 'README.md', 'docs/layout/wide.md'];

test('quick open needs every typed character in order, and ranks file-name and word-start matches first', () => {
  assert.equal(matchPath('lib/fuzzy-path.ts', 'zzq'), null);
  assert.equal(rankPaths(files, 'wbl')[0].path, 'lib/workbench-layout.ts');
  assert.equal(rankPaths(files, 'readme')[0].path, 'README.md');
  assert.equal(rankPaths(files, 'HandworkWorkbench')[0].path, 'components/site/HandworkWorkbench.tsx');
  // Words narrow by folder and by name, in any order.
  assert.deepEqual(rankPaths(files, 'docs wide').map(match => match.path), ['docs/layout/wide.md']);
  assert.deepEqual(rankPaths(files, 'layout test').map(match => match.path), ['tests/desktop/workbench-layout.test.mjs']);
  const { positions } = matchPath('lib/fuzzy-path.ts', 'fp');
  assert.deepEqual(positions, [4, 10], 'the matched letters are the word starts, for highlighting');
});

test('renaming a file or folder carries its tabs along; deleting one closes them', () => {
  let layout = openInEditor(openInEditor(openInEditor(emptyLayout(), 'src/a.ts'), 'src/lib/b.ts'), 'srcs/c.ts');
  const first = layout.focused;
  layout = splitPane(layout, first, { id: 'p2', kind: 'editor', files: ['src/lib/b.ts'], active: 'src/lib/b.ts' }, 'row');
  const renamed = renameInLayout(layout, 'src', 'app');
  assert.deepEqual(renamed.panes[first].files, ['app/a.ts', 'app/lib/b.ts', 'srcs/c.ts']);
  assert.equal(renamed.panes[first].active, 'srcs/c.ts');
  assert.equal(renamed.panes.p2.active, 'app/lib/b.ts');
  assert.equal(movedPath('srcs/c.ts', 'src', 'app'), 'srcs/c.ts', 'a sibling with a longer name is not inside the folder');
  const closed = closeWithin(renamed, 'app/lib');
  assert.deepEqual(closed.panes[first].files, ['app/a.ts', 'srcs/c.ts']);
  assert.deepEqual(closed.panes.p2.files, []);
});

test('syntax errors are found from the parse tree, in the languages whose grammars report them', () => {
  assert.ok(isLintable('src/a.tsx') && isLintable('x.py') && isLintable('data.json'));
  assert.ok(!isLintable('README.md') && !isLintable('main.rs') && !isLintable('Makefile'));
  const lint = (doc, typescript = false) => syntaxDiagnostics(EditorState.create({ doc, extensions: javascript({ typescript }) }));
  assert.deepEqual(lint('const a = [1, 2];\nfunction f(x) { return x; }\n'), []);
  const [error] = lint('const a = (1 + ;\n');
  assert.equal(error.severity, 'error');
  assert.match(error.message, /^Unexpected/);
  // Grammar gaps are not reported as mistakes.
  assert.deepEqual(lint('const isText = (x: unknown): x is string => typeof x === "string";\n', true), []);
});

test('change bars mark lines added, changed and deleted since the file was staged, as it is edited', async () => {
  const { gitGutter, setGitBase, hasGitBase, changedLines } = await import('../../components/site/editorGitGutter.ts');
  let state = EditorState.create({ doc: 'one\ntwo\nthree\nfour\n', extensions: gitGutter() });
  assert.deepEqual(changedLines(state), [], 'nothing is marked until the staged text arrives');
  state = state.update({ effects: setGitBase.of('one\ntwo\nthree\nfour\n') }).state;
  assert.ok(hasGitBase(state, 'one\r\ntwo\r\nthree\r\nfour\r\n'), 'line endings do not count as changes');
  assert.deepEqual(changedLines(state), []);
  state = state.update({ changes: { from: 4, to: 7, insert: 'TWO' } }).state;
  assert.deepEqual(changedLines(state), [{ line: 2, kind: 'modified' }]);
  state = state.update({ changes: { from: state.doc.length, insert: 'five\n' } }).state;
  assert.deepEqual(changedLines(state).at(-1), { line: 5, kind: 'added' });
  // Lines removed next to a changed one are part of that change; removed on their own, they are marked where they were.
  let removed = EditorState.create({ doc: 'a\nb\nc\nd\n', extensions: gitGutter() });
  removed = removed.update({ effects: setGitBase.of('a\nb\nc\nd\n') }).state;
  removed = removed.update({ changes: { from: 2, to: 4 } }).state;
  assert.deepEqual(changedLines(removed), [{ line: 2, kind: 'deleted' }]);
  assert.deepEqual(changedLines(state.update({ effects: setGitBase.of(null) }).state), [], 'an untracked file has no bars');
});

test('a saved layout comes back as it was left, with terminals ready for a new shell, and a damaged one is refused', () => {
  let layout = openInEditor(openInEditor(emptyLayout(), 'src/a.ts'), 'README.md');
  const editor = layout.focused;
  layout = splitPane(layout, editor, { id: 'term', kind: 'terminal', tabs: [{ id: 's1', terminalId: '00000000-0000-0000-0000-000000000000', shell: 'zsh', exited: true }, { id: 's2' }], active: 's2' }, 'column', 0.6);
  layout = { ...layout, focused: editor };
  const restored = readLayout(JSON.parse(JSON.stringify(restorableLayout(layout))));
  assert.deepEqual(restored.root, layout.root);
  assert.deepEqual(restored.panes[editor], { id: editor, kind: 'editor', files: ['src/a.ts', 'README.md'], active: 'README.md' });
  assert.deepEqual(restored.panes.term, { id: 'term', kind: 'terminal', tabs: [{ id: 's1', number: undefined }, { id: 's2', number: undefined }], active: 's2' });
  // A terminal pane saved before panes had tabs comes back with one shell.
  const legacy = readLayout({ ...layout, panes: { ...layout.panes, term: { id: 'term', kind: 'terminal', terminalId: 'x', shell: 'zsh' } } });
  assert.equal(legacy.panes.term.tabs.length, 1);
  assert.equal(legacy.panes.term.active, legacy.panes.term.tabs[0].id);
  assert.equal(restored.focused, editor);
  assert.equal(readLayout({ ...layout, focused: 'gone' }).focused, editor, 'a lost focus falls back to the first pane');
  for (const damaged of [null, 'text', { root: layout.root }, { ...layout, panes: { [editor]: layout.panes[editor] } }, { ...layout, panes: { ...layout.panes, [editor]: { id: editor, kind: 'editor', files: ['a'], active: 'b' } } }, { ...layout, root: { ...layout.root, ratio: 4 } }])
    assert.equal(readLayout(damaged), null, JSON.stringify(damaged)?.slice(0, 80));
});

test('a terminal pane keeps shells as tabs: new ones show, closing one shows its neighbour, and the last closes the pane', () => {
  const start = emptyLayout();
  const editor = start.focused;
  let layout = splitPane(start, editor, terminalPane('term'), 'column');
  const first = layout.panes.term.active;
  layout = updateTerminalTab(layout, 'term', first, { terminalId: 'id-1', shell: 'zsh' });
  layout = addTerminalTab(addTerminalTab(layout, 'term'), 'term');
  const [, second, third] = layout.panes.term.tabs.map(tab => tab.id);
  assert.equal(layout.panes.term.active, third, 'a new shell is shown');
  assert.equal(layout.panes.term.tabs[0].terminalId, 'id-1', 'the first keeps its shell');
  layout = closeTerminalTab(layout, 'term', third);
  assert.equal(layout.panes.term.active, second, 'closing the shown shell shows its neighbour');
  layout = closeTerminalTab(layout, 'term', first);
  assert.deepEqual(layout.panes.term.tabs.map(tab => tab.id), [second]);
  assert.equal(layout.panes.term.tabs[0].number, 2, 'a shell keeps its number as others close');
  assert.equal(addTerminalTab(layout, 'term').panes.term.tabs.at(-1).number, 3, 'and new ones count on from the highest');
  assert.equal(layout.panes.term.active, second);
  layout = closeTerminalTab(layout, 'term', second);
  assert.equal(layout.panes.term, undefined, 'closing the last shell closes the pane');
  assert.deepEqual(paneIds(layout.root), [editor]);
});
