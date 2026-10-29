import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function verifyMacApp(appPath, { release = false } = {}) {
  // Detect invalid Electron placeholder signatures, including in nested code.
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  if (release) {
    // An ad-hoc signature is useful locally but cannot qualify a public release.
    await run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
    await run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
  }
}
