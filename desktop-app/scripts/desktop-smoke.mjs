import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AcpClient } from '../electron/acp-client.mjs';
import { enginePath } from '../electron/engine-path.mjs';

// Run on the target OS against an unpacked app's resources directory.
// No account, model request, or provider charges are involved.
if (!process.argv[2]) throw new Error('Usage: node scripts/desktop-smoke.mjs <app-resources-directory>');
const resourcesPath = path.resolve(process.argv[2]);
const binary = enginePath({ packaged: true, resourcesPath });
await access(path.join(resourcesPath, 'handwork', 'lib', 'handwork', 'cli.mjs'));
const temporary = await mkdtemp(path.join(tmpdir(), 'handwork-smoke-'));
const env = {
  ...process.env, HOME: temporary, USERPROFILE: temporary,
  HANDWORK_AUTH_MODE: 'local', HANDWORK_DISABLE_KEYCHAIN: '1', HANDWORK_AUTO_UPGRADE: '0',
  HANDWORK_E2E_DISABLE_DOTENV: '1', OPENAI_API_KEY: 'desktop-smoke-fixture',
  HANDWORK_OPENAI_BASE_URL: 'http://127.0.0.1:1', HANDWORK_MODEL: 'gpt-test',
};
let client;
try {
  const { stdout } = await promisify(execFile)(binary, ['--version'], { env, timeout: 15000, windowsHide: true });
  assert.ok(stdout.trim(), 'Engine version is missing');
  client = new AcpClient({ binary, cwd: temporary, env, requestTimeout: 15000 });
  const result = await client.request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'handwork-desktop-smoke', version: '0.1.0' },
    clientCapabilities: { handwork: {
      standaloneChat: true,
      responseInstructions: JSON.parse(await readFile(new URL('../electron/standalone-prompt.json', import.meta.url), 'utf8')),
    } },
  });
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.agentCapabilities?.handwork?.standaloneChat, true,
    'Bundled engine must support desktop standalone chats; rebuild the native package');
  console.log(`Bundled engine starts and completes the desktop ACP handshake: ${stdout.trim()}`);
} finally {
  if (client) {
    client.dispose();
    await client.exited;
  }
  await rm(temporary, { recursive: true, force: true });
}
