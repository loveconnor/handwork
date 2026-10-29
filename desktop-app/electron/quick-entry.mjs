import { BrowserWindow, globalShortcut, screen } from 'electron';
import { EVENT_CHANNEL, attachments, isTrustedSender } from './ipc.mjs';

const WIDTH = 680;
const QUICK_CHANNEL = 'handwork-quick:';

/** Accepts the prompt a quick entry window hands to the main window. */
export function validQuickPrompt(text, files) {
  return typeof text === 'string' && Buffer.byteLength(text) <= 1024 * 1024 && !text.includes('\0') && attachments(files) && (text.trim().length > 0 || files.length > 0);
}

/** A compact composer that opens over any app from a global shortcut. */
export class QuickEntry {
  constructor({ ipcMain, rendererURL, load, preload, onSubmit, capture }) {
    Object.assign(this, { ipcMain, rendererURL, load, preload, onSubmit, capture });
    this.window = null;
    this.accelerator = 'off';
    const trusted = event => !!this.window && isTrustedSender(event, this.window.webContents, rendererURL);
    const handlers = {
      quickSubmit: (text, files) => {
        if (!validQuickPrompt(text, files)) throw new Error('Invalid quick entry prompt');
        this.hide();
        onSubmit({ text, attachments: files });
      },
      quickDismiss: () => { this.hide(); },
      quickCapture: () => this.captureFor(),
      quickResize: height => {
        if (!Number.isFinite(height) || !this.window) return;
        const bounds = this.window.getBounds();
        this.window.setBounds({ ...bounds, height: Math.round(Math.min(Math.max(height, 96), 520)) });
      },
    };
    for (const [method, handler] of Object.entries(handlers)) {
      ipcMain.handle(QUICK_CHANNEL + method, (event, ...args) => {
        if (!trusted(event)) throw new Error('Untrusted quick entry sender');
        return handler(...args);
      });
    }
  }

  create() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BrowserWindow({
      width: WIDTH, height: 148, show: false, frame: false, transparent: true, hasShadow: false,
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true,
      backgroundColor: '#00000000', title: 'Handwork Quick Entry',
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false },
    });
    window.setAlwaysOnTop(true, 'floating');
    if (process.platform === 'darwin') window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const wc = window.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', event => event.preventDefault());
    wc.on('will-attach-webview', event => event.preventDefault());
    // Clicking anywhere else dismisses it, like Spotlight.
    window.on('blur', () => { if (!this.capturing) this.hide(); });
    window.on('closed', () => { if (this.window === window) this.window = null; });
    this.load(window).catch(error => console.error(`Quick entry failed to load: ${error.message}`));
    this.window = window;
    return window;
  }

  show() {
    const window = this.create();
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    window.setBounds({ x: Math.round(workArea.x + (workArea.width - WIDTH) / 2), y: Math.round(workArea.y + workArea.height * 0.24), width: WIDTH, height: window.getBounds().height });
    window.show();
    window.focus();
    if (!window.webContents.isLoading()) window.webContents.send(EVENT_CHANNEL, { method: 'quick/show' });
  }

  hide() { if (this.window && !this.window.isDestroyed() && this.window.isVisible()) this.window.hide(); }
  toggle() { if (this.window?.isVisible() && this.window.isFocused()) this.hide(); else this.show(); }

  async captureFor() {
    // The window hides during capture; its blur must not discard the draft.
    this.capturing = true;
    try { return await this.capture(); }
    finally { this.capturing = false; if (this.window && !this.window.isDestroyed()) { this.window.show(); this.window.focus(); } }
  }

  /** Returns false when another app already owns the shortcut. */
  register(accelerator) {
    if (accelerator === this.accelerator) return true;
    if (this.accelerator !== 'off') globalShortcut.unregister(this.accelerator);
    this.accelerator = 'off';
    if (!accelerator || accelerator === 'off') return true;
    if (!globalShortcut.register(accelerator, () => this.toggle())) return false;
    this.accelerator = accelerator;
    return true;
  }

  dispose() {
    if (this.accelerator !== 'off') globalShortcut.unregister(this.accelerator);
    this.accelerator = 'off';
    for (const method of ['quickSubmit', 'quickDismiss', 'quickCapture', 'quickResize']) this.ipcMain.removeHandler(QUICK_CHANNEL + method);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
