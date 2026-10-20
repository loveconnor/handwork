import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, session, shell, Tray } from 'electron';
import path from 'node:path';
import { windowAction, windowState } from './window-controls.mjs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopSettings } from './desktop-settings.mjs';
import { SettingsService } from './settings-service.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DesktopBackend } from './backend.mjs';
import { EVENT_CHANNEL, registerIpc, allowsDesktopPermission } from './ipc.mjs';
import { ChatPreferences } from './chat-preferences.mjs';
import { ModelPreferences } from './model-preferences.mjs';
import { ProjectStore } from './project-store.mjs';
import { rendererPolicy } from './renderer-policy.mjs';
import { enginePath } from './engine-path.mjs';
import { existsSync } from 'node:fs';
import electronUpdater from 'electron-updater';
import { DesktopUpdater } from './updater.mjs';
import { UpdateDraftStore } from './update-drafts.mjs';
import { SavedPrompts } from './saved-prompts.mjs';
import { captureScreen } from './screen-capture.mjs';
import { QuickEntry } from './quick-entry.mjs';
import { DraftStore } from './draft-store.mjs';
import { QueueStore } from './queue-store.mjs';
import { BACKUP_EXTENSION } from './backup.mjs';
import { TrustedFiles } from './file-access.mjs';
import { appVersion } from './app-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appIcon = path.join(root, 'electron', 'assets', 'handwork.png');
const rendererFile = path.join(root, 'dist', 'index.html');
const rendererURL = app.isPackaged ? pathToFileURL(rendererFile).href : 'http://127.0.0.1:5173/harness';
const binary = enginePath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, root });
let window;
let backend;
let quitting = false;
// Set once the person asks to quit, so closing windows then really closes them.
let quitRequested = false;
let tray;
let trayHintShown = false;
let desktopUpdater;
let updateDrafts;
let quickEntry;
const liveNotifications = new Set();
const shortcutLabels = { 'Alt+Space': process.platform === 'darwin' ? '⌥ Space' : 'Alt+Space', 'Control+Alt+Space': process.platform === 'darwin' ? '⌃⌥ Space' : 'Ctrl+Alt+Space', 'CommandOrControl+Shift+Space': process.platform === 'darwin' ? '⇧⌘ Space' : 'Ctrl+Shift+Space' };
const cleanups = new Set();
function cleanup(currentBackend) {
  if (!currentBackend) return;
  const pending = currentBackend.dispose();
  cleanups.add(pending);
  pending.finally(() => cleanups.delete(pending));
}

/** Registers the quick entry shortcut and tells the main window when another app owns it. */
function applyQuickEntryShortcut(accelerator, webContents) {
  if (quickEntry?.register(accelerator) !== false) return;
  if (webContents && !webContents.isDestroyed()) webContents.send(EVENT_CHANNEL, { method: 'desktop/notice', params: { message: `Another app is using ${shortcutLabels[accelerator] ?? accelerator}. Choose a different quick entry shortcut in Settings › General.` } });
}

/** Every caller is an explicit request to see Handwork, so it comes to the front. */
function showMainWindow() {
  if (!window || window.isDestroyed()) { createWindow(); return; }
  if (window.isMinimized()) window.restore();
  window.show();
  // macOS keeps a background app behind others unless it is asked to take focus.
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.focus();
}

/** Windows has no Dock, so a hidden Handwork stays reachable from the notification area. */
function syncTray(enabled) {
  if (process.platform !== 'win32') return;
  if (!enabled) { tray?.destroy(); tray = undefined; return; }
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(appIcon).resize({ width: 16, height: 16 }));
  tray.setToolTip('Handwork');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Handwork', click: showMainWindow },
    { label: 'Quick entry', click: () => quickEntry?.show() },
    { type: 'separator' },
    { label: 'Quit Handwork', click: () => app.quit() },
  ]));
  tray.on('click', showMainWindow);
}

function createWindow() {
  // Voice dictation is delegated to Wispr Flow when it is installed; the mic stays hidden otherwise.
  const voice = {
    status: async () => {
      const name = app.getApplicationNameForProtocol('wispr-flow://');
      return name ? { available: true, name } : { available: false };
    },
    start: () => shell.openExternal('wispr-flow://start-hands-free'),
    stop: () => shell.openExternal('wispr-flow://stop-hands-free'),
  };
  const settings = new DesktopSettings(path.join(app.getPath('userData'), 'desktop-settings.json'));
  const settingsService = new SettingsService({ settings, version: appVersion, host: {
    chooseFolder: async () => { const result = await dialog.showOpenDialog(window, { title: 'Allow an additional project folder', properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0]; },
    saveExport: async ({ format = 'json', defaultName = 'handwork-chats.json' } = {}) => {
      const filters = format === 'markdown' ? [{ name: 'Markdown', extensions: ['md'] }] : [{ name: 'JSON', extensions: ['json'] }];
      const result = await dialog.showSaveDialog(window, { title: format === 'markdown' ? 'Export chat as Markdown' : 'Export chat as JSON', defaultPath: path.join(app.getPath('documents'), defaultName), filters });
      return result.canceled ? null : result.filePath;
    },
    saveBackup: async ({ defaultName }) => {
      const result = await dialog.showSaveDialog(window, { title: 'Back up Handwork', defaultPath: path.join(app.getPath('documents'), defaultName), filters: [{ name: 'Handwork backup', extensions: [BACKUP_EXTENSION] }] });
      return result.canceled ? null : result.filePath;
    },
    chooseBackup: async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Restore from a Handwork backup', properties: ['openFile'], filters: [{ name: 'Handwork backup', extensions: [BACKUP_EXTENSION] }] });
      return result.canceled ? null : result.filePaths[0];
    },
    openFile: async (file, editor) => {
      const applications = { vscode: 'Visual Studio Code', cursor: 'Cursor', zed: 'Zed' };
      if (editor !== 'system' && process.platform === 'darwin') { await promisify(execFile)('/usr/bin/open', ['-a', applications[editor], file], { timeout: 5000 }); return; }
      if (editor !== 'system') { await promisify(execFile)({ vscode: 'code', cursor: 'cursor', zed: 'zed' }[editor], [file], { timeout: 5000 }); return; }
      const error = await shell.openPath(file); if (error) throw new Error(error);
    },
    openTerminal: directory => {
      if (process.platform === 'darwin') return promisify(execFile)('/usr/bin/open', ['-a', 'Terminal', directory], { timeout: 5000 }).then(() => {});
      const [command, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', 'start', '', '/D', directory, 'cmd.exe']] : ['x-terminal-emulator', []];
      return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: directory, detached: true, stdio: 'ignore', windowsHide: false });
        child.once('error', () => reject(new Error('Could not open a terminal. Open one in this folder yourself.')));
        child.once('spawn', () => { child.unref(); resolve(); });
      });
    },
    openReleases: () => shell.openExternal('https://github.com/loveconnor/handwork/releases'),
    openHelp: () => shell.openExternal('https://github.com/loveconnor/handwork#readme'),
    checkUpdates: () => desktopUpdater.check(),
    getUpdateState: () => desktopUpdater.snapshot(),
    downloadUpdate: () => desktopUpdater.download(),
    installUpdate: drafts => desktopUpdater.install(drafts),
    getUpdateDrafts: () => updateDrafts.take(),
    captureScreen: () => captureScreen(),
  } });
  const notify = (kind, sessionId) => {
    try {
    const preferences = settings.snapshot().app;
    if (kind !== 'test' && (!preferences[{ complete: 'notifyComplete', approval: 'notifyApproval', error: 'notifyError' }[kind]] || (preferences.notificationsBackgroundOnly && window?.isFocused()))) return;
    if (!Notification.isSupported()) { if (kind === 'test') throw new Error('Desktop notifications are unavailable on this system'); return; }
    const notification = new Notification({ title: 'Handwork', body: { complete: 'Your response is ready.', approval: 'Handwork needs your approval.', error: 'A response could not finish. Open Handwork for details.', test: 'Desktop notifications are ready. If this does not appear, allow Handwork notifications in system settings.' }[kind], silent: !preferences.notificationSound });
    notification.on('click', () => {
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
      // Take the person to the chat that finished or is waiting for approval.
      if (typeof sessionId === 'string' && sessionId) window.webContents.send(EVENT_CHANNEL, { method: 'desktop/open-chat', params: { sessionId, reason: kind } });
    });
    // Keep a reference so the click handler survives garbage collection.
    liveNotifications.add(notification);
    for (const done of ['close', 'click', 'failed']) notification.on(done, () => liveNotifications.delete(notification));
    notification.show();
    } catch (error) { if (kind === 'test') throw error; }
  };
  backend = new DesktopBackend({ binary, settingsService, notify, chatPreferences: new ChatPreferences(path.join(app.getPath('userData'), 'chat-preferences.json')), projects: new ProjectStore(path.join(app.getPath('userData'), 'projects.json')), voice, attachmentDirectory: path.join(app.getPath('userData'), 'attachments'), chatDirectory: path.join(app.getPath('userData'), 'chats'), savedPrompts: new SavedPrompts(path.join(app.getPath('userData'), 'saved-prompts.json')), drafts: new DraftStore(path.join(app.getPath('userData'), 'drafts')), queues: new QueueStore(path.join(app.getPath('userData'), 'queues')), trustedFiles: new TrustedFiles(path.join(app.getPath('userData'), 'picked-files.json')), modelPreferences: new ModelPreferences(path.join(app.getPath('userData'), 'model-preferences.json')), shell });
  const currentBackend = backend;
  window = new BrowserWindow({
    icon: appIcon,
    autoHideMenuBar: true,
    width: 1280, height: 860, minWidth: 800, minHeight: 600,
    // Window controls sit above the sidebar; the workspace toolbar shares the top edge.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } } : {}),
    // Integrate Windows caption buttons into the app toolbar, like macOS.
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: false } : {}),
    backgroundColor: '#161618',
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    },
  });
  const currentWindow = window;
  const wc = window.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (['https:', 'http:'].includes(target.protocol) && !target.username && !target.password) {
        void shell.openExternal(target.href).catch(error => console.error(`Could not open source: ${error.message}`));
      }
    } catch { /* Invalid links cannot leave the app. */ }
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event) => event.preventDefault());
  wc.on('will-redirect', (event) => event.preventDefault());
  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.on('render-process-gone', () => cleanup(currentBackend));
  const unregister = registerIpc({
    ipcMain, webContents: wc, rendererURL, backend: currentBackend,
    windowAction: action => windowAction(currentWindow, action),
    chooseWorkspace: async () => {
      const result = await dialog.showOpenDialog(currentWindow, { properties: ['openDirectory'], title: 'Choose Handwork workspace' });
      return !currentWindow.isDestroyed() && !result.canceled ? result.filePaths[0] : null;
    },
    chooseFiles: async () => {
      const result = await dialog.showOpenDialog(currentWindow, { properties: ['openFile', 'multiSelections'], title: 'Attach files' });
      return !currentWindow.isDestroyed() && !result.canceled ? result.filePaths : [];
    },
  });
  // The renderer reserves room for the traffic lights only while they are visible.
  const sendWindowState = () => { if (!wc.isDestroyed()) wc.send(EVENT_CHANNEL, { method: 'window/state', params: windowState(currentWindow) }); };
  currentWindow.on('maximize', sendWindowState);
  currentWindow.on('unmaximize', sendWindowState);
  currentWindow.on('enter-full-screen', sendWindowState);
  currentWindow.on('leave-full-screen', sendWindowState);
  wc.on('did-finish-load', sendWindowState);
  const sendUpdateState = state => { if (!wc.isDestroyed()) wc.send(EVENT_CHANNEL, { method: 'desktop/update', params: state }); };
  desktopUpdater.on('state', sendUpdateState);
  wc.on('did-finish-load', () => sendUpdateState(desktopUpdater.snapshot()));
  currentBackend.on('event', event => {
    if (event.method !== 'desktop/settings') return;
    applyQuickEntryShortcut(event.params?.app?.quickEntryShortcut, wc);
    syncTray(event.params?.app?.keepRunning === true);
  });
  wc.once('did-finish-load', () => {
    try { const preferences = settings.snapshot().app; applyQuickEntryShortcut(preferences.quickEntryShortcut, wc); syncTray(preferences.keepRunning === true); }
    catch { /* Unreadable settings are reported by the renderer. */ }
  });
  const keepRunning = () => { try { return settings.snapshot().app.keepRunning === true; } catch { return false; } };
  currentWindow.on('close', event => {
    // In background mode, closing hides the window: replies, queued messages, and
    // quick entry keep working until the person quits.
    if (!quitRequested && keepRunning()) {
      event.preventDefault();
      if (currentWindow.isFullScreen()) { currentWindow.once('leave-full-screen', () => currentWindow.hide()); currentWindow.setFullScreen(false); }
      else currentWindow.hide();
      if (tray && !trayHintShown) {
        trayHintShown = true;
        tray.displayBalloon({ title: 'Handwork is still running', content: 'Open it from here, or use your quick entry shortcut. Quit from this icon to stop it.', iconType: 'info' });
      }
      return;
    }
    cleanup(currentBackend);
  });
  currentWindow.on('closed', () => {
    desktopUpdater.removeListener('state', sendUpdateState);
    unregister();
    cleanup(currentBackend);
    if (window === currentWindow) window = null;
    // A hidden quick entry window must not keep the app alive after its main window closes.
    quickEntry?.hide();
    if (quickEntry?.window && !quickEntry.window.isDestroyed()) quickEntry.window.destroy();
  });
  const load = app.isPackaged ? currentWindow.loadFile(rendererFile) : currentWindow.loadURL(rendererURL);
  load.catch((error) => {
    cleanup(currentBackend);
    console.error(`Renderer failed to load: ${error.message}`);
    currentWindow.close();
  });
}

// Do not await readiness at module scope: Electron (and automation hosts) must
// finish loading the entry module before completing their readiness handshake.
app.setName('Handwork');
if (process.platform === 'win32') app.setAppUserModelId('com.handwork.desktop');
const ownsInstance = app.requestSingleInstanceLock();
app.on('second-instance', () => { if (window) showMainWindow(); });
if (ownsInstance) app.whenReady().then(async () => {
updateDrafts = new UpdateDraftStore(path.join(app.getPath('userData'), 'update-drafts.json'));
let signedMac = process.platform !== 'darwin';
if (app.isPackaged && process.platform === 'darwin') {
  try {
    const bundle = path.resolve(path.dirname(process.execPath), '../..');
    await promisify(execFile)('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    const signature = await promisify(execFile)('/usr/bin/codesign', ['-dv', '--verbose=2', bundle]);
    signedMac = signature.stderr.includes('Authority=Developer ID Application:');
  } catch { signedMac = false; }
}
desktopUpdater = new DesktopUpdater({
  updater: electronUpdater.autoUpdater,
  available: app.isPackaged && signedMac && existsSync(path.join(process.resourcesPath, 'app-update.yml')),
  unavailableReason: app.isPackaged && !signedMac ? 'Install a signed Handwork release to enable updates on this Mac.' : 'Install a release build to enable updates.',
  isBusy: () => !!(backend?.prompting || backend?.running),
  // Installing restarts the app, so its windows must really close.
  beforeInstall: async drafts => { updateDrafts.save(drafts); quitRequested = true; },
});
desktopUpdater.start();
powerMonitor.on('resume', () => void desktopUpdater.checkIfDue());
app.on('browser-window-focus', () => void desktopUpdater.checkIfDue());
// Packaged macOS apps use the native asset catalog, including clear and tinted icons.
if (process.platform === 'darwin' && !app.isPackaged) {
  const updateDockIcon = () => app.dock.setIcon(nativeTheme.shouldUseDarkColors
    ? path.join(root, 'electron', 'assets', 'handwork-dark.png') : appIcon);
  updateDockIcon();
  nativeTheme.on('updated', updateDockIcon);
}
// Tab and chat actions from the menu run in the main window; quick entry ignores them.
function sendTabAction(action) {
  if (!window || window.isDestroyed()) return;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && focused !== window) { if (action === 'close') focused.close(); return; }
  window.webContents.send(EVENT_CHANNEL, { method: 'desktop/tab', params: { action } });
}
const updateMenuIcon = process.platform === 'darwin'
  ? nativeImage.createFromNamedImage('arrow.triangle.2.circlepath').resize({ width: 12, height: 12 })
  : undefined;
updateMenuIcon?.setTemplateImage(true);
Menu.setApplicationMenu(Menu.buildFromTemplate([
  ...(process.platform === 'darwin' ? [{ role: 'appMenu', submenu: [
    { role: 'about' },
    { label: 'Check for Updates…', icon: updateMenuIcon, click: async () => {
      const state = await desktopUpdater.check();
      if (['idle', 'error', 'unavailable'].includes(state.status)) {
        const options = { type: state.status === 'error' ? 'warning' : 'info', title: 'Handwork Updates', message: state.message };
        if (window && !window.isDestroyed()) await dialog.showMessageBox(window, options);
        else await dialog.showMessageBox(options);
      } else if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
    } },
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit' },
  ] }] : []),
  { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => window?.webContents.send(EVENT_CHANNEL, { method: 'desktop/open-settings' }) },
  { role: 'editMenu' },
  { label: 'View', submenu: [
    { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
    { type: 'separator' }, { role: 'togglefullscreen' },
    ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : []),
  ] },
  // Close Tab and Close Window are separate: ⌘W closes the chat tab, ⇧⌘W the window.
  { label: 'Chat', submenu: [
    { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => sendTabAction('new') },
    { type: 'separator' },
    { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: () => sendTabAction('next') },
    { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: () => sendTabAction('previous') },
    { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendTabAction('reopen') },
    { type: 'separator' },
    { label: 'Next Chat Needing Attention', accelerator: 'CmdOrCtrl+Shift+A', click: () => sendTabAction('attention') },
    { label: 'Chat Details', accelerator: 'CmdOrCtrl+I', click: () => sendTabAction('details') },
    { type: 'separator' },
    { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendTabAction('close') },
    { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', click: () => { const focused = BrowserWindow.getFocusedWindow(); if (focused && !focused.isDestroyed()) focused.close(); } },
  ] },
  { label: 'Window', submenu: [
    { role: 'minimize' }, { role: 'zoom' },
    ...(process.platform === 'darwin' ? [{ type: 'separator' }, { role: 'front' }] : []),
  ] },
  { role: 'help', submenu: [
    { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => { if (!window || window.isDestroyed()) return; showMainWindow(); window.webContents.send(EVENT_CHANNEL, { method: 'desktop/open-shortcuts' }); } },
    { label: 'Handwork Help', click: () => void shell.openExternal('https://github.com/loveconnor/handwork#readme') },
  ] },
]));
session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => callback(allowsDesktopPermission(wc, window?.webContents, rendererURL, permission, details)));
session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => allowsDesktopPermission(wc, window?.webContents, rendererURL, permission, details));
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  const csp = rendererPolicy(app.isPackaged);
  callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
});
quickEntry = new QuickEntry({
  ipcMain, rendererURL, preload: path.join(root, 'electron', 'preload.cjs'),
  load: quick => app.isPackaged ? quick.loadFile(rendererFile, { hash: 'quick' }) : quick.loadURL(`${rendererURL}#quick`),
  capture: () => captureScreen(),
  onSubmit: prompt => {
    if (!window || window.isDestroyed()) return;
    showMainWindow();
    window.webContents.send(EVENT_CHANNEL, { method: 'desktop/quick-prompt', params: prompt });
  },
});
createWindow();
}).catch(error => { console.error(`Handwork startup failed: ${error.message}`); app.quit(); });
if (!ownsInstance) app.quit();
// Clicking the Dock icon brings back a window hidden in background mode.
app.on('activate', () => { if (ownsInstance) showMainWindow(); });
app.on('before-quit', (event) => {
  quitRequested = true;
  desktopUpdater?.stop();
  if (quitting) return;
  event.preventDefault();
  cleanup(backend);
  // Keep Electron alive until SIGTERM/SIGKILL cleanup has completed.
  void Promise.allSettled([...cleanups]).then(() => { quitting = true; app.quit(); });
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { quickEntry?.dispose(); tray?.destroy(); globalShortcut.unregisterAll(); });
process.once('SIGTERM', () => app.quit());
process.once('SIGINT', () => app.quit());
