import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const assets = path.join(root, 'electron', 'assets');
const { stdout } = await exec('xcode-select', ['-p']);
const tool = path.resolve(stdout.trim(), '../Applications/Icon Composer.app/Contents/Executables/ictool');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'handwork-icons-'));
try {
  for (const [rendition, filename] of [['Default', 'handwork.png'], ['Dark', 'handwork-dark.png']]) {
    const rendered = path.join(temporary, filename);
    await exec(tool, [path.join(assets, 'Handwork.icon'), '--export-image', '--output-file', rendered,
      '--platform', 'macOS', '--rendition', rendition, '--width', '824', '--height', '824', '--scale', '1']);
    // Electron's development host needs a flattened icon with the legacy macOS safe area.
    await sharp(rendered).extend({ top: 100, bottom: 100, left: 100, right: 100,
      background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(path.join(assets, filename));
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
