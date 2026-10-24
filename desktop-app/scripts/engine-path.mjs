import path from 'node:path';
import { existsSync } from 'node:fs';

export function engineSourceRoot(root) {
  const parent = path.resolve(root, '..');
  return existsSync(path.join(parent, 'build.zig')) ? parent : path.join(parent, 'handwork');
}

export function engineFilename(platform = process.platform) {
  return platform === 'win32' ? 'handwork.exe' : 'handwork';
}

export function enginePath({ packaged, resourcesPath, root, platform = process.platform, override = process.env.HANDWORK_BINARY }) {
  const filename = engineFilename(platform);
  // Packaged apps always run their bundled engine, never an environment override.
  return packaged
    ? path.join(resourcesPath, 'handwork-engine', 'bin', filename)
    : path.resolve(override || path.join(engineSourceRoot(root), 'zig-out/bin', filename));
}
