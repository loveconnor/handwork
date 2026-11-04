import electron from 'electron';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * The identity the local app is signed with. macOS Keychain remembers "Always Allow" by an app's
 * signature: an ad-hoc signature changes whenever the app is rebuilt, so the "Handwork Safe Storage"
 * prompt returns, while a certificate's Team ID stays the same, as installed apps' does.
 * HANDWORK_DEV_SIGNING_IDENTITY picks one; otherwise a Developer ID or Apple Development
 * certificate on this Mac is used, and ad-hoc signing only when there is none.
 */
async function signingIdentity() {
  if (process.env.HANDWORK_DEV_SIGNING_IDENTITY) return process.env.HANDWORK_DEV_SIGNING_IDENTITY;
  try {
    const { stdout } = await exec('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']);
    const names = [...stdout.matchAll(/^\s*\d+\) [0-9A-F]{40} "([^"]+)"$/gm)].map(match => match[1]);
    return names.find(name => name.startsWith('Developer ID Application:')) ?? names.find(name => name.startsWith('Apple Development:')) ?? '-';
  } catch { return '-'; }
}

export async function desktopRuntime() {
  if (process.platform !== 'darwin') return electron;

  const source = path.resolve(electron, '../../..');
  const distribution = path.dirname(source);
  const version = (await readFile(path.join(distribution, 'version'), 'utf8')).trim();
  const cache = path.resolve(distribution, '../../.cache/handwork-desktop');
  const identity = await signingIdentity();
  // Each identity gets its own copy, so changing it signs a fresh one.
  const signer = identity === '-' ? 'adhoc' : identity.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60);
  const destination = path.join(cache, `${version}-v3-${signer}`);
  const executable = path.join(destination, 'Handwork.app/Contents/MacOS/Electron');
  try {
    await access(executable, constants.X_OK);
    return executable;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(cache, { recursive: true });
  const temporary = await mkdtemp(path.join(cache, 'prepare-'));
  try {
    const bundle = path.join(temporary, 'Handwork.app');
    await cp(source, bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    const plist = path.join(bundle, 'Contents/Info.plist');
    for (const [key, value] of Object.entries({
      CFBundleName: 'Handwork',
      CFBundleDisplayName: 'Handwork',
      CFBundleIdentifier: 'com.handwork.desktop.dev',
    })) {
      await exec('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
    }
    const microphoneDescription = 'Handwork uses your microphone for offline dictation. Audio stays on your device.';
    await exec('/usr/libexec/PlistBuddy', ['-c', `Set :NSMicrophoneUsageDescription ${microphoneDescription}`, plist])
      .catch(() => exec('/usr/libexec/PlistBuddy', ['-c', `Add :NSMicrophoneUsageDescription string ${microphoneDescription}`, plist]));
    // Changing bundle metadata invalidates the original signature; sign this local copy.
    await exec('/usr/bin/codesign', ['--force', '--deep', '--sign', identity, bundle]);
    await rename(temporary, destination);
    return executable;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
