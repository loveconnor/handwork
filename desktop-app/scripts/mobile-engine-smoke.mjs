import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopBackend } from '../electron/backend.mjs';
import { MobileWorkspace } from '../electron/mobile-workspace.mjs';
import { SettingsService } from '../electron/settings-service.mjs';
import { AcpClient } from '../electron/acp-client.mjs';
import { enginePath } from '../electron/engine-path.mjs';
const home = await mkdtemp(path.join(tmpdir(), 'handwork-mobile-engine-'));
const fixture = createServer(async (request, response) => {
  for await (const _chunk of request) { /* local fixture only */ }
  if (request.url.includes('models')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'gpt-test' }] })); return; }
  response.setHeader('content-type', 'text/event-stream');
  response.end([{ choices: [{ delta: { content: 'mobile-electron-smoke-ok' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'].map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join(''));
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, HOME: home, USERPROFILE: home, HANDWORK_AUTH_MODE: 'local', HANDWORK_DISABLE_KEYCHAIN: '1', HANDWORK_AUTO_UPGRADE: '0', HANDWORK_E2E_DISABLE_DOTENV: '1', OPENAI_API_KEY: 'local-fixture-only', HANDWORK_MODEL: 'gpt-test', HANDWORK_OPENAI_BASE_URL: `http://127.0.0.1:${fixture.address().port}` };
for (const key of Object.keys(env)) if (/API_KEY|TOKEN|SECRET/i.test(key) && key !== 'OPENAI_API_KEY') delete env[key];
const backend = new DesktopBackend({ binary: enginePath({ root: path.resolve('.'), packaged: false }), settingsService: new SettingsService({ home }), clientFactory: options => new AcpClient({ ...options, env }) });
const mobile = new MobileWorkspace(backend);
try {
  const catalog = await mobile.handle('workspace.list', {});
  const { sessionId } = await mobile.handle('session.start', { projectId: catalog.projects[0].id, text: 'Reply with the fixture greeting.' });
  assert.equal(backend.workspace, null, 'phone must not change desktop workspace');
  const deadline = Date.now() + 30000;
  let conversation;
  do { await new Promise(resolve => setTimeout(resolve, 100)); conversation = await mobile.handle('conversation.read', { conversationId: sessionId }); } while (conversation.busy && Date.now() < deadline);
  assert.equal(conversation.busy, false);
  assert.match(JSON.stringify(conversation.turns), /mobile-electron-smoke-ok/);
  assert.ok((await mobile.handle('workspace.list', {})).sessions.some(s => s.id === sessionId));
  const models = await mobile.handle('models.list', { projectId: catalog.projects[0].id, conversationId: sessionId });
  assert.ok(models.models.some(model => model.name === 'gpt-test'), 'phone must see the engine model catalog');
  await mobile.handle('session.rename', { conversationId: sessionId, title: 'From phone' });
  assert.equal((await mobile.handle('workspace.list', {})).sessions.find(s => s.id === sessionId).title, 'From phone');
  console.log('Real engine: mobile creates, sends, reads, and renames the shared Electron chat without changing desktop focus.');
} finally { mobile.dispose(); await backend.dispose(); await new Promise(resolve => fixture.close(resolve)); await rm(home, { recursive: true, force: true }); }
