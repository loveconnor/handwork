import { build, Platform, Arch } from 'electron-builder';
import { desktopTarget } from './desktop-engine.mjs';
import { verifyMacApp } from './verify-macos-app.mjs';
import { finalizeMacArtifacts, notarizationCredentials } from './finalize-macos-artifacts.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || (platform === 'win32' ? 'x64' : process.arch);
const target = desktopTarget(platform, arch);
const release = process.argv.includes('--release');
const notaryCredentials = platform === 'darwin' && release ? notarizationCredentials() : null;
const { buildDesktop } = await import('./desktop-build.mjs');
await buildDesktop(target);
const artifacts = await build({
  targets: (platform === 'win32' ? Platform.WINDOWS : Platform.MAC)
    .createTarget(platform === 'win32' ? ['nsis'] : release ? ['dmg', 'zip'] : ['dir'], Arch[arch]),
  config: {
    ...(process.argv.includes('--fixture') ? { directories: { output: 'release-fixture' } } : {}),
    ...(platform === 'darwin' && release ? { dmg: { sign: true } } : {}),
    publish: [{ provider: 'generic', url: 'https://github.com/loveconnor/handwork/releases/download/desktop-stable', channel: platform === 'win32' ? `latest-${arch}` : 'latest' }],
    ...(platform === 'darwin' ? release ? { forceCodeSigning: true, mac: { hardenedRuntime: true, notarize: true } } : { mac: { identity: '-', hardenedRuntime: false, notarize: false, timestamp: 'none' } } : {}),
  },
  publish: 'never',
});
if (platform === 'darwin') {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const output = process.argv.includes('--fixture') ? 'release-fixture' : 'release';
  await verifyMacApp(path.join(root, output, target.directory, 'Handwork.app'), { release });
  if (release) await finalizeMacArtifacts(artifacts, notaryCredentials);
}
