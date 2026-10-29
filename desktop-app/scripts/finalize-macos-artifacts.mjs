import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { notarize } from '@electron/notarize';
import yaml from 'js-yaml';

const run = promisify(execFile);

export function notarizationCredentials(env = process.env) {
  if (env.APPLE_KEYCHAIN_PROFILE) return {
    keychainProfile: env.APPLE_KEYCHAIN_PROFILE,
    ...(env.APPLE_KEYCHAIN ? { keychain: env.APPLE_KEYCHAIN } : {}),
  };
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) return {
    appleId: env.APPLE_ID,
    appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: env.APPLE_TEAM_ID,
  };
  throw new Error('Configure a notarization Keychain profile or Apple ID, app-specific password, and Team ID before building a Mac release.');
}

export async function refreshMacUpdateMetadata(directory) {
  const manifestPath = path.join(directory, 'latest-mac.yml');
  const manifest = yaml.load(await readFile(manifestPath, 'utf8'));
  for (const entry of manifest.files) {
    const file = path.join(directory, path.basename(entry.url));
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    entry.sha512 = hash.digest('base64');
    entry.size = (await stat(file)).size;
    delete entry.blockMapSize;
  }
  manifest.sha512 = manifest.files.find(entry => path.basename(entry.url) === path.basename(manifest.path)).sha512;
  await writeFile(manifestPath, yaml.dump(manifest));
}

export async function finalizeMacArtifacts(artifacts, credentials) {
  for (const artifact of artifacts.filter(file => file.endsWith('.dmg'))) {
    const dmg = path.resolve(artifact);
    await run('/usr/bin/codesign', ['--verify', '--strict', dmg]);
    await notarize({ appPath: dmg, ...credentials });
    await run('/usr/bin/xcrun', ['stapler', 'validate', dmg]);
    await run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', dmg]);
    // Stapling changes the DMG bytes after electron-builder generated metadata.
    // Discard its obsolete differential map and hash the final public artifact.
    await rm(`${dmg}.blockmap`, { force: true });
    await refreshMacUpdateMetadata(path.dirname(dmg));
  }
}
