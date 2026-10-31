import { app, BrowserWindow, desktopCapturer, nativeImage, screen, systemPreferences } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { MAX_ATTACHMENT_BYTES } from './ipc.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function stampedName(extension) {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `Screenshot ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} at ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}.${extension}`;
}

/** Keeps a capture under the attachment limit, preferring lossless PNG. */
export function encodeCapture(image) {
  const png = image.toPNG();
  if (png.length <= MAX_ATTACHMENT_BYTES) return { name: stampedName('png'), mimeType: 'image/png', size: png.length, data: png.toString('base64') };
  let current = image;
  for (const quality of [88, 80, 70, 60]) {
    const jpeg = current.toJPEG(quality);
    if (jpeg.length <= MAX_ATTACHMENT_BYTES) return { name: stampedName('jpg'), mimeType: 'image/jpeg', size: jpeg.length, data: jpeg.toString('base64') };
    const { width } = current.getSize();
    current = current.resize({ width: Math.round(width * 0.8), quality: 'best' });
  }
  throw new Error('The screenshot is too large to attach. Capture a smaller area.');
}

/** Hides Handwork while the person picks what to capture, then restores it. */
async function withAppHidden(action) {
  const visible = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.isVisible());
  const focused = BrowserWindow.getFocusedWindow();
  if (process.platform === 'darwin') app.hide(); else for (const window of visible) window.hide();
  await wait(process.platform === 'darwin' ? 120 : 300);
  try { return await action(); }
  finally {
    if (process.platform === 'darwin') app.show();
    for (const window of visible) if (!window.isDestroyed()) window.showInactive();
    if (focused && !focused.isDestroyed()) focused.focus();
  }
}

/**
 * macOS uses the system picker: drag a region, or press Space and click a window.
 * Windows captures the display under the pointer.
 */
export async function captureScreen() {
  if (process.platform === 'darwin') {
    const access = systemPreferences.getMediaAccessStatus('screen');
    if (access === 'denied' || access === 'restricted') throw new Error('Allow Handwork in System Settings › Privacy & Security › Screen & System Audio Recording, then try again.');
    const file = path.join(app.getPath('temp'), `handwork-capture-${randomUUID()}.png`);
    try {
      await withAppHidden(() => promisify(execFile)('/usr/bin/screencapture', ['-i', '-x', '-o', '-t', 'png', file], { timeout: 5 * 60 * 1000 }));
      const bytes = await readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      // Escape leaves no file: the person cancelled.
      if (!bytes?.length) return null;
      return encodeCapture(nativeImage.createFromBuffer(bytes));
    } finally { await unlink(file).catch(() => {}); }
  }
  return withAppHidden(async () => {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const thumbnailSize = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
    const source = sources.find(item => item.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('Handwork could not capture the screen.');
    return encodeCapture(source.thumbnail);
  });
}
