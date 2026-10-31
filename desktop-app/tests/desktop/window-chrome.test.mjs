import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
const source = file => readFileSync(new URL('../../' + file, import.meta.url), 'utf8');

test('Windows caption controls use the integrated toolbar without changing Mac or Linux', () => {
  const main = source('electron/main.mjs');
  const branches = main.split('\n').filter(line => line.includes('titleBarStyle:'));
  const options = platform => Object.assign({}, ...branches.map(line => new Function('process', 'return ' + line.trim().slice(3, -1))({ platform })));
  assert.equal(options('win32').titleBarStyle, 'hidden');
  assert.equal(options('win32').titleBarOverlay, false);
  assert.equal(options('darwin').titleBarStyle, 'hiddenInset');
  assert.equal(options('darwin').titleBarOverlay, undefined);
  assert.deepEqual(options('linux'), {});
});

test('Windows control spacing is limited to windowed desktop and preserves interactive tabs', () => {
  const harness = source('components/site/HandworkHarness.tsx');
  const expression = harness.split('\n').find(line => line.includes('const desktopWindows =')).split(' = ')[1].trim().replace(/;$/, '');
  const enabled = new Function('api', 'fullscreen', 'navigator', 'return ' + expression);
  assert.equal(enabled({}, false, { userAgent: 'Windows NT' }), true);
  assert.equal(enabled({}, true, { userAgent: 'Windows NT' }), false);
  assert.equal(enabled(null, false, { userAgent: 'Windows NT' }), false);
  assert.equal(enabled({}, false, { userAgent: 'Macintosh' }), false);
  const css = source('desktop/desktop.css');
  assert.match(css, /handwork-windows[^}]+margin-right: 138px; padding-right: 8px/);
  assert.match(css, /handwork-windows[^}]+-webkit-app-region: drag/);
  assert.match(css, /handwork-windows[^}]+handwork-tab[^}]+-webkit-app-region: no-drag/);
});

test('caption actions preserve minimize, maximize/restore, close handling and destroyed windows', async () => {
  const { windowAction } = await import('../../electron/window-controls.mjs');
  let maximized = false;
  let destroyed = false;
  const calls = [];
  const window = {
    isDestroyed: () => destroyed, isFullScreen: () => false, isMaximized: () => maximized,
    minimize: () => calls.push('minimize'),
    maximize: () => { maximized = true; calls.push('maximize'); },
    unmaximize: () => { maximized = false; calls.push('restore'); },
    close: () => calls.push('close'),
  };
  assert.deepEqual(windowAction(window, 'state'), { fullscreen: false, maximized: false });
  windowAction(window, 'minimize');
  assert.equal(windowAction(window, 'toggle-maximize').maximized, true);
  assert.equal(windowAction(window, 'toggle-maximize').maximized, false);
  assert.equal(windowAction(window, 'close'), undefined);
  assert.throws(() => windowAction(window, 'quit'), /Invalid window action/);
  destroyed = true;
  assert.equal(windowAction(window, 'minimize'), undefined);
  assert.deepEqual(calls, ['minimize', 'maximize', 'restore', 'close']);
});

test('caption IPC rejects foreign senders and unknown actions, and cleans up handlers', async () => {
  const { EventEmitter } = await import('node:events');
  const { registerIpc, validateArguments } = await import('../../electron/ipc.mjs');
  const handlers = new Map();
  const rendererURL = 'http://127.0.0.1:5173/';
  const frame = { url: rendererURL };
  const wc = { isDestroyed: () => false, mainFrame: frame };
  const backend = new EventEmitter();
  const actions = [];
  const cleanup = registerIpc({ ipcMain: { handle: (channel, callback) => handlers.set(channel, callback), removeHandler: channel => handlers.delete(channel) }, webContents: wc, rendererURL, backend, windowAction: action => actions.push(action) });
  const call = handlers.get('handwork:windowAction');
  const trusted = { sender: wc, senderFrame: frame };
  assert.throws(() => call({ sender: {}, senderFrame: frame }, 'close'), /Untrusted/);
  assert.throws(() => call({ sender: wc, senderFrame: { url: rendererURL } }, 'close'), /Untrusted/);
  for (const args of [[], ['quit'], ['close', 'extra'], [{}]]) assert.throws(() => validateArguments('windowAction', args), /Invalid/);
  for (const action of ['state', 'minimize', 'toggle-maximize', 'close']) call(trusted, action);
  assert.deepEqual(actions, ['state', 'minimize', 'toggle-maximize', 'close']);
  cleanup();
  assert.equal(handlers.size, 0);
});

test('all caption buttons use shared hover tooltips without native titles', () => {
  const controls = source('components/site/HandworkWindowControls.tsx');
  assert.equal((controls.match(/<HoverTooltip /g) || []).length, 3);
  assert.doesNotMatch(controls, /title=/);
  for (const label of ['Minimize', 'Restore', 'Maximize', 'Close']) assert.ok(controls.includes(label));
  assert.ok(source('electron/preload.cjs').includes('windowAction'));
});
