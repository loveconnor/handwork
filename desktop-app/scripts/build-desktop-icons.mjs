import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, copyFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// Keep the original Handwork Icon Composer source and its legacy padded
// rendition together. Tauri embeds the PNGs; macOS uses Assets.car and ICNS.
const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const macos = path.join(root, 'src-tauri', 'macos');
const icons = path.join(root, 'src-tauri', 'icons');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'handwork-icons-'));
const tauri = path.join(root, 'node_modules', '.bin', 'tauri');
try {
  const generated = path.join(temporary, 'fallback');
  await exec(tauri, ['icon', path.join(macos, 'dock-icon.png'), '--output', generated]);
  for (const entry of await readdir(generated, { withFileTypes: true })) {
    if (entry.isFile()) await copyFile(path.join(generated, entry.name), path.join(icons, entry.name));
  }
  await exec('xcrun', ['actool', path.join(macos, 'AppIcon.icon'), '--compile', temporary,
    '--platform', 'macosx', '--minimum-deployment-target', '11.0', '--app-icon', 'AppIcon',
    '--output-partial-info-plist', path.join(temporary, 'info.plist')]);
  await copyFile(path.join(temporary, 'AppIcon.icns'), path.join(icons, 'icon.icns'));
  await copyFile(path.join(temporary, 'Assets.car'), path.join(macos, 'Assets.car'));
  const mark = await readFile(path.join(macos, 'AppIcon.icon', 'Assets', 'handwork.svg'), 'utf8');
  const traySource = path.join(temporary, 'tray.svg');
  await writeFile(traySource, mark.replaceAll('#111111', '#ffffff'));
  const tray = path.join(temporary, 'tray');
  await exec(tauri, ['icon', traySource, '--output', tray, '--png', '256']);
  await copyFile(path.join(tray, '256x256.png'), path.join(macos, 'menu-bar.png'));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
