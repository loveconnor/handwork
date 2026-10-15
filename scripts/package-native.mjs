// Stage every binary required by the portable npm package. This never publishes.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { matchesTarget } = require('../bin/handwork.cjs');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const targets = [
  ['darwin', 'arm64', 'aarch64-macos'],
  ['win32', 'x64', 'x86_64-windows-gnu'],
  ['win32', 'arm64', 'aarch64-windows-gnu'],
];
const checkOnly = process.argv.includes('--check');
const selected = process.argv.find(value => value.startsWith('--target='))?.slice('--target='.length);
for (const [platform, arch, zigTarget] of targets) {
  if (selected && selected !== `${platform}-${arch}`) continue;
  const prefix = join(root, 'prebuilds', `${platform}-${arch}`);
  if (!checkOnly) {
    // Keep native macOS SDK discovery, but always use a baseline Windows
    // target so a package built on Windows does not require its builder's CPU.
    const nativeMac = platform === 'darwin' && platform === process.platform && arch === process.arch;
    const result = spawnSync('zig', ['build', ...(nativeMac ? [] : [`-Dtarget=${zigTarget}`]), '-Doptimize=ReleaseFast', '--prefix', prefix], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  const binary = join(prefix, 'bin', platform === 'win32' ? 'handwork.exe' : 'handwork');
  if (!matchesTarget(binary, platform, arch)) throw new Error(`Missing or incorrect executable: ${binary}`);
}
