import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) throw new Error('Only run on a disposable GitHub Actions runner.');
const keychain = path.join(process.env.RUNNER_TEMP, 'handwork-signing.keychain-db');
if (process.argv.includes('--cleanup')) {
  try { execFileSync('security', ['delete-keychain', keychain], { stdio: 'ignore' }); } catch { /* The runner may not have reached signing setup. */ }
  process.exit(0);
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('Missing TAURI_SIGNING_PRIVATE_KEY');
const config = { bundle: { createUpdaterArtifacts: true } };
if (process.platform === 'darwin') {
  const certificate = path.join(process.env.RUNNER_TEMP, 'handwork-signing.p12');
  const password = randomBytes(32).toString('hex');
  const security = args => {
    // Security can include command arguments in errors; never log them.
    try { return execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw new Error('Could not configure the temporary macOS signing keychain.'); }
  };
  try {
    await writeFile(certificate, Buffer.from(process.env.MAC_CSC_LINK || '', 'base64'), { mode: 0o600 });
    security(['create-keychain', '-p', password, keychain]);
    security(['set-keychain-settings', '-lut', '21600', keychain]);
    security(['unlock-keychain', '-p', password, keychain]);
    security(['import', certificate, '-k', keychain, '-P', process.env.MAC_CSC_KEY_PASSWORD || '', '-T', '/usr/bin/codesign', '-T', '/usr/bin/productbuild']);
    security(['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', password, keychain]);
    const previous = security(['list-keychains', '-d', 'user']).split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
    security(['list-keychains', '-d', 'user', '-s', keychain, ...previous]);
    const identity = /"(Developer ID Application:[^"]+)"/.exec(security(['find-identity', '-v', '-p', 'codesigning', keychain]))?.[1];
    if (!identity) throw new Error('No valid Developer ID Application identity in MAC_CSC_LINK.');
    config.bundle.macOS = { signingIdentity: identity };
    // The native launcher is bundled as a resource, so sign it explicitly
    // before Tauri signs and notarizes the outer app.
    execFileSync('codesign', ['--force', '--timestamp', '--options', 'runtime', '--sign', identity, process.env.HANDWORK_BINARY], { stdio: 'inherit' });
  } finally {
    await rm(certificate, { force: true });
  }
}
const base = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
if (!base.plugins?.updater?.pubkey || !base.plugins.updater.endpoints?.length) throw new Error('Updater public key and feed must be configured.');
await writeFile('src-tauri/.release-build.json', JSON.stringify(config));
