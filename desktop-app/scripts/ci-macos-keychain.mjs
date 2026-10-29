import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP) {
  throw new Error('This script manages only a disposable GitHub macOS runner keychain.');
}
const root = process.env.RUNNER_TEMP;
const keychain = path.join(root, 'handwork-signing.keychain-db');
const roots = path.join(root, 'handwork-apple-roots.keychain');
const state = path.join(root, 'handwork-signing-state.json');
const certificate = path.join(root, 'handwork-signing.p12');
const keychainPassword = randomBytes(32).toString('hex');
const certificatePassword = process.env.MAC_CSC_KEY_PASSWORD;

async function security(args, description) {
  try { return (await exec('/usr/bin/security', args)).stdout; }
  catch (error) {
    let detail = String(error.stderr || '').trim();
    for (const secret of [keychainPassword, certificatePassword, process.env.MAC_CSC_LINK]) {
      if (secret) detail = detail.replaceAll(secret, '[redacted]');
    }
    throw new Error(`${description} failed: ${detail || 'security command failed'}`);
  }
}

async function cleanup() {
  let previous;
  try { previous = JSON.parse(await readFile(state, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await security(['list-keychains', '-d', 'user', '-s', ...previous], 'Restore runner keychain search list');
  await security(['delete-keychain', keychain], 'Delete temporary signing keychain');
  await rm(roots, { force: true });
  await rm(certificate, { force: true });
  await rm(state, { force: true });
}

if (process.argv.includes('--cleanup')) {
  await cleanup();
} else {
  if (!process.env.MAC_CSC_LINK || !certificatePassword || !process.env.GITHUB_ENV) {
    throw new Error('Missing Mac certificate secrets or GitHub environment file.');
  }
  const previous = (await security(['list-keychains', '-d', 'user'], 'Read runner keychain search list'))
    .split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
  await writeFile(state, JSON.stringify(previous), { mode: 0o600 });
  try {
    await writeFile(certificate, Buffer.from(process.env.MAC_CSC_LINK, 'base64'), { mode: 0o600 });
    await security(['create-keychain', '-p', keychainPassword, keychain], 'Create temporary signing keychain');
    await security(['unlock-keychain', '-p', keychainPassword, keychain], 'Unlock temporary signing keychain');
    await security(['set-keychain-settings', '-lut', '21600', keychain], 'Configure temporary keychain timeout');
    await security(['import', certificate, '-k', keychain, '-P', certificatePassword, '-T', '/usr/bin/codesign', '-T', '/usr/bin/productbuild'], 'Import Developer ID certificate');
    await security(['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', keychainPassword, keychain], 'Allow signing tools to use the temporary key');
    const builderRoot = path.dirname(fileURLToPath(import.meta.resolve('app-builder-lib/package.json')));
    await copyFile(path.join(builderRoot, 'certs/root_certs.keychain'), roots);
    await security(['list-keychains', '-d', 'user', '-s', keychain, roots, ...previous], 'Add temporary signing keychain to runner search list');
    const identities = await security(['find-identity', '-v', '-p', 'codesigning', keychain], 'Validate signing identity');
    if (!identities.includes('Developer ID Application:')) throw new Error('Imported certificate is not a valid Developer ID Application identity.');
    await writeFile(process.env.GITHUB_ENV, `CSC_KEYCHAIN=${keychain}\n`, { flag: 'a' });
    console.log('Developer ID imported into an unlocked temporary runner keychain.');
  } catch (error) {
    try { await cleanup(); } catch { /* The disposable runner removes any residual keychain. */ }
    throw error;
  } finally {
    await rm(certificate, { force: true });
  }
}
