import electron from 'electron';
import { execFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function desktopRuntime() {
  if (process.platform !== 'darwin') return electron;

  const source = path.resolve(electron, '../../..');
  const distribution = path.dirname(source);
  const version = (await readFile(path.join(distribution, 'version'), 'utf8')).trim();
  const cache = path.resolve(distribution, '../../.cache/handwork-desktop');
  const destination = path.join(cache, `${version}-v1`);
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
    // Changing bundle metadata invalidates the original signature; sign this local copy.
    await exec('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
    await rename(temporary, destination);
    return executable;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
