import { build, Platform, Arch } from 'electron-builder';
import { desktopTarget } from './desktop-engine.mjs';

const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || (platform === 'win32' ? 'x64' : process.arch);
const target = desktopTarget(platform, arch);
const release = process.argv.includes('--release');
const { buildDesktop } = await import('./desktop-build.mjs');
await buildDesktop(target);
await build({
  targets: (platform === 'win32' ? Platform.WINDOWS : Platform.MAC)
    .createTarget(platform === 'win32' ? ['nsis'] : release ? ['dmg', 'zip'] : ['dir'], Arch[arch]),
  config: {
    ...(process.argv.includes('--fixture') ? { directories: { output: 'release-fixture' } } : {}),
    publish: [{ provider: 'generic', url: 'https://github.com/loveconnor/handwork/releases/download/desktop-stable', channel: platform === 'win32' ? `latest-${arch}` : 'latest' }],
    ...(platform === 'darwin' ? release ? { forceCodeSigning: true, mac: { hardenedRuntime: true, notarize: true } } : { mac: { identity: null } } : {}),
  },
  publish: 'never',
});
