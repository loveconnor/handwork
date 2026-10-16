import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, session, shell } from 'electron';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopSettings } from './desktop-settings.mjs';
import { SettingsService } from './settings-service.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DesktopBackend } from './backend.mjs';
import { EVENT_CHANNEL, registerIpc, allowsDesktopPermission } from './ipc.mjs';
import { ChatPreferences } from './chat-preferences.mjs';
import { ProjectStore } from './project-store.mjs';
import { rendererPolicy } from './renderer-policy.mjs';
import { enginePath } from './engine-path.mjs';
import { existsSync } from 'node:fs';
import electronUpdater from 'electron-updater';
import { DesktopUpdater } from './updater.mjs';
import { UpdateDraftStore } from './update-drafts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appIcon = path.join(root, 'electron', 'assets', 'handwork.png');
const rendererFile = path.join(root, 'dist', 'index.html');
const rendererURL = app.isPackaged ? pathToFileURL(rendererFile).href : 'http://127.0.0.1:5173/harness';
const binary = enginePath({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, root });
let window;
let backend;
let quitting = false;
let desktopUpdater;
let updateDrafts;
const cleanups = new Set();
function cleanup(currentBackend) {
  if (!currentBackend) return;
  const pending = currentBackend.dispose();
  cleanups.add(pending);
  pending.finally(() => cleanups.delete(pending));
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
  const settingsService = new SettingsService({ settings, version: app.getVersion(), host: {
    chooseFolder: async () => { const result = await dialog.showOpenDialog(window, { title: 'Allow an additional project folder', properties: ['openDirectory'] }); return result.canceled ? null : result.filePaths[0]; },
    saveExport: async () => { const result = await dialog.showSaveDialog(window, { title: 'Export chat text', defaultPath: 'handwork-chats.json', filters: [{ name: 'JSON', extensions: ['json'] }] }); return result.canceled ? null : result.filePath; },
    openFile: async (file, editor) => {
      const applications = { vscode: 'Visual Studio Code', cursor: 'Cursor', zed: 'Zed' };
      if (editor !== 'system' && process.platform === 'darwin') { await promisify(execFile)('/usr/bin/open', ['-a', applications[editor], file], { timeout: 5000 }); return; }
      if (editor !== 'system') { await promisify(execFile)({ vscode: 'code', cursor: 'cursor', zed: 'zed' }[editor], [file], { timeout: 5000 }); return; }
      const error = await shell.openPath(file); if (error) throw new Error(error);
    },
    openReleases: () => shell.openExternal('https://github.com/loveconnor/handwork/releases'),
    openHelp: () => shell.openExternal('https://github.com/loveconnor/handwork#readme'),
    checkUpdates: () => desktopUpdater.check(),
    getUpdateState: () => desktopUpdater.snapshot(),
    downloadUpdate: () => desktopUpdater.download(),
    installUpdate: drafts => desktopUpdater.install(drafts),
    getUpdateDrafts: () => updateDrafts.take(),
  } });
  const notify = kind => {
    try {
    const preferences = settings.snapshot().app;
    if (kind !== 'test' && (!preferences[{ complete: 'notifyComplete', approval: 'notifyApproval', error: 'notifyError' }[kind]] || (preferences.notificationsBackgroundOnly && window?.isFocused()))) return;
    if (!Notification.isSupported()) { if (kind === 'test') throw new Error('Desktop notifications are unavailable on this system'); return; }
    const notification = new Notification({ title: 'Handwork', body: { complete: 'Your response is ready.', approval: 'Handwork needs your approval.', error: 'A response could not finish. Open Handwork for details.', test: 'Desktop notifications are ready. If this does not appear, allow Handwork notifications in system settings.' }[kind], silent: !preferences.notificationSound });
    notification.on('click', () => { if (window && !window.isDestroyed()) { window.show(); window.focus(); } });
    notification.show();
    } catch (error) { if (kind === 'test') throw error; }
  };
  backend = new DesktopBackend({ binary, settingsService, notify, chatPreferences: new ChatPreferences(path.join(app.getPath('userData'), 'chat-preferences.json')), projects: new ProjectStore(path.join(app.getPath('userData'), 'projects.json')), voice, attachmentDirectory: path.join(app.getPath('userData'), 'attachments'), chatDirectory: path.join(app.getPath('userData'), 'chats') });
  const currentBackend = backend;
  window = new BrowserWindow({
    icon: appIcon,
    width: 1280, height: 860, minWidth: 800, minHeight: 600,
    // Window controls sit above the sidebar; the workspace toolbar shares the top edge.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } } : {}),
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
  const sendWindowState = () => { if (!wc.isDestroyed()) wc.send(EVENT_CHANNEL, { method: 'window/state', params: { fullscreen: currentWindow.isFullScreen() } }); };
  currentWindow.on('enter-full-screen', sendWindowState);
  currentWindow.on('leave-full-screen', sendWindowState);
  wc.on('did-finish-load', sendWindowState);
  const sendUpdateState = state => { if (!wc.isDestroyed()) wc.send(EVENT_CHANNEL, { method: 'desktop/update', params: state }); };
  desktopUpdater.on('state', sendUpdateState);
  wc.on('did-finish-load', () => sendUpdateState(desktopUpdater.snapshot()));
  currentWindow.on('close', () => cleanup(currentBackend));
  currentWindow.on('closed', () => {
    desktopUpdater.removeListener('state', sendUpdateState);
    unregister();
    cleanup(currentBackend);
    if (window === currentWindow) window = null;
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
app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
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
  beforeInstall: async drafts => { updateDrafts.save(drafts); },
});
desktopUpdater.start();
// Packaged macOS apps use the native asset catalog, including clear and tinted icons.
if (process.platform === 'darwin' && !app.isPackaged) {
  const updateDockIcon = () => app.dock.setIcon(nativeTheme.shouldUseDarkColors
    ? path.join(root, 'electron', 'assets', 'handwork-dark.png') : appIcon);
  updateDockIcon();
  nativeTheme.on('updated', updateDockIcon);
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
  { role: 'windowMenu' },
]));
session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => callback(allowsDesktopPermission(wc, window?.webContents, rendererURL, permission, details)));
session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => allowsDesktopPermission(wc, window?.webContents, rendererURL, permission, details));
session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
  const csp = rendererPolicy(app.isPackaged);
  callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
});
createWindow();
}).catch(error => { console.error(`Handwork startup failed: ${error.message}`); app.quit(); });
if (!ownsInstance) app.quit();
app.on('activate', () => { if (ownsInstance && !window) createWindow(); });
app.on('before-quit', (event) => {
  desktopUpdater?.stop();
  if (quitting) return;
  event.preventDefault();
  cleanup(backend);
  // Keep Electron alive until SIGTERM/SIGKILL cleanup has completed.
  void Promise.allSettled([...cleanups]).then(() => { quitting = true; app.quit(); });
});
app.on('window-all-closed', () => app.quit());
process.once('SIGTERM', () => app.quit());
process.once('SIGINT', () => app.quit());
