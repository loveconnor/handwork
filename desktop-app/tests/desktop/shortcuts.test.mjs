import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { shortcutGroups } from '../../lib/shortcuts.ts';
import { shortcutKeys } from '../../lib/saved-prompts.ts';

const find = (groups, label) => groups.flatMap(group => group.items).find(item => item.label === label);
const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('the reference follows the send key and quick entry settings', () => {
  const enter = shortcutGroups({ sendKey: 'enter', quickEntryShortcut: 'Alt+Space' });
  assert.deepEqual(find(enter, 'Send message').keys, ['Enter']);
  assert.deepEqual(find(enter, 'New line').keys, ['Shift+Enter']);
  assert.deepEqual(find(enter, 'Quick entry from any app').keys, ['Alt+Space']);
  const modifier = shortcutGroups({ sendKey: 'modifier-enter', quickEntryShortcut: 'CommandOrControl+Shift+Space' });
  assert.deepEqual(find(modifier, 'Send message').keys, ['Mod+Enter']);
  assert.deepEqual(find(modifier, 'New line').keys, ['Enter', 'Shift+Enter']);
  assert.deepEqual(find(modifier, 'Quick entry from any app').keys, ['Mod+Shift+Space']);
  assert.equal(find(shortcutGroups({ quickEntryShortcut: 'off' }), 'Quick entry from any app'), undefined);
});

test('the browser preview lists only shortcuts it can handle', () => {
  const groups = shortcutGroups({ desktop: false, quickEntryShortcut: 'Alt+Space' });
  assert.ok(!groups.some(group => group.title === 'Window'));
  assert.equal(find(groups, 'Settings'), undefined);
  assert.equal(find(groups, 'Quick entry from any app'), undefined);
  assert.deepEqual(find(shortcutGroups({ mac: true }), 'Full screen').keys, ['Control+Mod+F']);
  assert.deepEqual(find(shortcutGroups({ mac: false }), 'Full screen').keys, ['F11']);
  assert.equal(find(shortcutGroups({ mac: false }), 'Quit Handwork'), undefined);
});

test('listed app shortcuts match the handlers that implement them', () => {
  const listed = new Set(shortcutGroups({ desktop: true, mac: true }).flatMap(group => group.items.flatMap(item => item.keys)));
  for (const keys of ['Mod+K', 'Mod+N', 'Mod+F', 'Mod+/', 'Mod+,', 'Mod+G']) assert.ok(listed.has(keys), `${keys} is listed`);
  const harness = source('components/site/HandworkHarness.tsx');
  assert.match(harness, /key === 'n'/);
  assert.match(harness, /key === '\/'/);
  assert.match(harness, /key === 'f'/);
  for (const keys of ['Mod+Shift+E', 'Mod+J', 'Mod+P', 'Mod+Shift+F']) assert.ok(listed.has(keys), `${keys} is listed`);
  assert.match(harness, /key === 'e' && showProjectTools/);
  assert.match(harness, /key === 'j' && ideView/);
  assert.match(source('components/site/HandworkCommandPalette.tsx'), /event\.key\.toLowerCase\(\) === 'k'/);
  assert.match(source('components/site/HandworkFindBar.tsx'), /event\.key\.toLowerCase\(\) !== 'g'/);
  const main = source('electron/main.mjs');
  assert.match(main, /accelerator: 'CmdOrCtrl\+,'/);
  assert.match(main, /label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl\+\/'/);
});

test('native tab actions cannot bypass an open modal or in-progress draft recovery', () => {
  const harness = source('components/site/HandworkHarness.tsx');
  const action = harness.slice(harness.indexOf('  function runTabAction(action: TabAction) {'), harness.indexOf('  useEffect(() => {\n    if (!tabRequest) return;'));
  assert.match(action, /if \(settingsOpen \|\| recoveringDraft \|\| \(lock\.current && !pendingChat\) \|\| document\.querySelector\('\[role="dialog"\], \[role="alertdialog"\]'\)\) return;/);
  assert.ok(action.indexOf('document.querySelector') < action.indexOf('lastTabAction.current ='));
});

test('keys render in each platform’s notation', () => {
  assert.deepEqual(shortcutKeys('Mod+Shift+G', true), ['⌘', '⇧', 'G']);
  assert.deepEqual(shortcutKeys('Mod+Shift+G', false), ['Ctrl', 'Shift', 'G']);
  assert.deepEqual(shortcutKeys('Escape', true), ['Esc']);
  assert.deepEqual(shortcutKeys('Mod+Plus', false), ['Ctrl', '+']);
  assert.deepEqual(shortcutKeys('ArrowUp+ArrowDown', true), ['↑', '↓']);
});

test('the IDE view’s menus run actions the window handles, and leave the editor’s own keys to it', async () => {
  const { ideMenus, IDE_ACTIONS } = await import('../../electron/ide-menu.mjs');
  const ran = [];
  const menus = ideMenus(action => ran.push(action), { mac: true });
  const items = [...menus.file.submenu, ...menus.view, ...menus.go.submenu, ...menus.terminal.submenu].filter(item => item.click);
  for (const item of items) item.click();
  assert.ok(ran.every(action => IDE_ACTIONS.includes(action)), ran.filter(action => !IDE_ACTIONS.includes(action)).join());
  const byLabel = label => items.find(item => item.label === label);
  // The editor answers these keys itself; the menu only shows them.
  for (const label of ['Go to Definition', 'Rename Symbol', 'Save', 'Go to File…']) assert.equal(byLabel(label).registerAccelerator, false, label);
  // Nothing else handles these, so the menu takes the keys.
  for (const label of ['Save All', 'New Terminal']) assert.equal(byLabel(label).registerAccelerator, true, label);
  const harness = source('components/site/HandworkHarness.tsx'), workbench = source('components/site/HandworkWorkbench.tsx');
  for (const action of IDE_ACTIONS) assert.ok(harness.includes(`'${action}'`) || workbench.includes(`case '${action}'`), `${action} is handled`);
});
