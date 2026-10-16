import { access, chmod, copyFile, cp, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { engineFilename, engineSourceRoot } from '../electron/engine-path.mjs';

export function desktopTarget(platform = process.platform, arch = process.arch) {
  if (!['darwin-arm64', 'win32-x64', 'win32-arm64'].includes(`${platform}-${arch}`)) {
    throw new Error(`Unsupported desktop target: ${platform}-${arch}`);
  }
  return { platform, arch, directory: `${platform === 'darwin' ? 'mac' : 'win'}-${arch}` };
}

export async function assertEngineTarget(binary, { platform, arch }) {
  const file = await open(binary, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    let matches = false;
    if (platform === 'darwin') {
      matches = bytesRead >= 8 && header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === 0x0100000c;
    } else if (bytesRead >= 64 && header.readUInt16LE(0) === 0x5a4d) {
      const offset = header.readUInt32LE(0x3c);
      matches = offset + 6 <= bytesRead && header.readUInt32LE(offset) === 0x00004550
        && header.readUInt16LE(offset + 4) === (arch === 'arm64' ? 0xaa64 : 0x8664);
    }
    if (!matches) throw new Error(`Engine has the wrong executable format or architecture for ${platform}-${arch}: ${binary}`);
  } finally {
    await file.close();
  }
}

export async function stageEngine(root, target, override = process.env.HANDWORK_BINARY) {
  const engineRoot = engineSourceRoot(root);
  const filename = engineFilename(target.platform);
  // Native development builds use zig-out; cross-packaging uses the staged native package.
  const prefix = target.platform === process.platform && target.arch === process.arch
    ? path.join(engineRoot, 'zig-out')
    : path.join(engineRoot, 'prebuilds', `${target.platform}-${target.arch}`);
  const binary = path.resolve(override || path.join(prefix, 'bin', filename));
  await assertEngineTarget(binary, target);
  const runtime = path.resolve(path.dirname(binary), '../lib/handwork');
  await access(path.join(runtime, 'cli.mjs'));
  const destination = path.join(root, 'resources', target.directory, 'handwork');
  await rm(destination, { recursive: true, force: true });
  await mkdir(path.join(destination, 'bin'), { recursive: true });
  await copyFile(binary, path.join(destination, 'bin', filename));
  await chmod(path.join(destination, 'bin', filename), 0o755);
  await cp(runtime, path.join(destination, 'lib', 'handwork'), { recursive: true });
  return destination;
}
