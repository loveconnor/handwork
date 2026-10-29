import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc', 'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-arm64': 'aarch64-unknown-linux-gnu' };
export async function stageMobile(target = { platform: process.platform, arch: process.arch }) {
  const triple = targets[`${target.platform}-${target.arch}`]; if (!triple) throw new Error('Unsupported mobile transport target');
  const filename = `handwork-mobile-host${target.platform === 'win32' ? '.exe' : ''}`;
  console.log(`Building mobile transport for ${triple}`);
  await promisify(execFile)('cargo', ['build', '--release', '--locked', '-p', 'handwork-mobile-link', '--bin', 'handwork-mobile-host', '--features', 'desktop-host', '--target', triple], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const folder = path.join(root, 'resources', `${target.platform === 'darwin' ? 'mac' : target.platform === 'win32' ? 'win' : target.platform}-${target.arch}`, 'mobile');
  await mkdir(folder, { recursive: true });
  await copyFile(path.join(root, 'target', triple, 'release', filename), path.join(folder, filename));
  await chmod(path.join(folder, filename), 0o755);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await stageMobile();
