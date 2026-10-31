import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Cdp, pause } from './cdp.mjs';

const [executable, output] = process.argv.slice(2);
await mkdir(output, { recursive: true });
const results = [];
const restrictedPath = [process.env.SystemRoot, path.join(process.env.SystemRoot, 'System32'), path.join(process.env.SystemRoot, 'System32/Wbem')].join(';');
const baseEnv = { ...process.env, PATH: restrictedPath, HANDWORK_BINARY: 'C:\\missing\\handwork.exe', HANDWORK_AUTO_UPGRADE: '0', HANDWORK_DISABLE_KEYCHAIN: '1', HANDWORK_E2E_DISABLE_DOTENV: '1' };
delete baseEnv.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(baseEnv)) {
  if (/API_KEY|TOKEN|SECRET|HANDWORK.*(MODEL|BASE_URL|AUTH_MODE)/i.test(key)) delete baseEnv[key];
}
for (const command of ['node', 'npm', 'zig', 'git', 'handwork']) {
  const found = spawnSync(path.join(process.env.SystemRoot, 'System32/where.exe'), [command], { env: baseEnv });
  assert.notEqual(found.status, 0, `${command} must not be available to the app`);
}

async function check(name, action) {
  try { const details = await action(); results.push({ name, passed: true, details }); console.log(`PASS ${name}: ${JSON.stringify(details)}`); }
  catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function launch(name, extraEnv, action) {
  const profile = path.join(output, name);
  await mkdir(profile, { recursive: true });
  const env = { ...baseEnv, HOME: profile, USERPROFILE: profile, ...extraEnv };
  const port = name === 'first-launch' ? 9333 : 9334;
  const app = spawn(executable, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  app.stdout.on('data', chunk => { log += chunk; });
  app.stderr.on('data', chunk => { log += chunk; });
  app.on('error', error => { log += error.stack; });
  let cdp;
  try {
    const deadline = Date.now() + 45000;
    let page;
    while (Date.now() < deadline) {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()).catch(() => []);
      page = pages.find(page => page.type === 'page' && page.url.startsWith('file:'));
      if (page) break;
      if (app.exitCode !== null) throw new Error(`App exited ${app.exitCode}: ${log}`);
      await pause(500);
    }
    assert.ok(page, `Renderer did not open: ${log}`);
    cdp = new Cdp(page.webSocketDebuggerUrl);
    let ready = false;
    const readyDeadline = Date.now() + 30000;
    while (Date.now() < readyDeadline) {
      try {
        ready = await cdp.evaluate(`document.readyState === 'complete' && !!window.handwork && document.body.innerText.includes('Handwork')`);
      } catch (error) {
        // The file URL becomes visible before Chromium commits its document.
        if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
      }
      if (ready) break;
      await pause(200);
    }
    assert.ok(ready, 'Preload/UI did not finish loading');
    return await action(cdp);
  } finally {
    if (cdp) {
      const screenshot = await cdp.request('Page.captureScreenshot').catch(() => null);
      if (screenshot?.data) await writeFile(path.join(output, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
      await writeFile(path.join(output, `${name}-body.txt`), await cdp.evaluate('document.body.innerText').catch(() => 'renderer closed'));
      cdp.close();
    }
    spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(app.pid), '/T', '/F']);
    await writeFile(path.join(output, `${name}.log`), log);
    await pause(1000);
  }
}
await check('first launch without developer tools or existing credentials', () => launch('first-launch', {}, async cdp => {
  const info = await cdp.evaluate('window.handwork.settingsInfo()');
  assert.notEqual(info.engineVersion, 'Unavailable', 'Bundled engine cannot start');
  await pause(2000);
  const providers = await cdp.evaluate('window.handwork.listProviders()');
  assert.ok(Array.isArray(providers?.providers) && providers.providers.length, 'New users need to see provider sign-in choices');
  await cdp.evaluate(`document.querySelector('button[aria-label="Settings"]')?.click(); [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Settings')?.click(); true`);
  await pause(500);
  await cdp.evaluate(`[...document.querySelectorAll('nav[aria-label="Settings sections"] button')].find(button => button.textContent.includes('Models'))?.click(); true`);
  await pause(1000);
  assert.ok(await cdp.evaluate(`[...document.querySelectorAll('.handwork-provider-list button')].some(button => button.textContent.trim() === 'Sign in' && !button.disabled)`), 'In-app browser sign-in must be available before a chat exists');
  return info;
}));
let requests = 0;
const fixture = createServer(async (request, response) => {
  for await (const chunk of request) { /* Drain request body. */ }
  if (request.url.includes('models')) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
    return;
  }
  requests++;
  response.setHeader('content-type', 'text/event-stream');
  const chunks = [
    { choices: [{ delta: { content: 'windows-desktop-smoke-ok' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5 } },
    '[DONE]',
  ];
  response.end(chunks.map(chunk => `data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`).join(''));
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
try {
  await check('bundled engine creates a chat and streams a response without external runtimes', () => launch('chat', {
    HANDWORK_AUTH_MODE: 'local', HANDWORK_MODEL: 'gpt-test', HANDWORK_OPENAI_BASE_URL: `http://127.0.0.1:${fixture.address().port}`,
  }, async cdp => {
    await pause(2500);
    await cdp.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Settings')?.click(); true`);
    await pause(500);
    await cdp.evaluate(`[...document.querySelectorAll('nav[aria-label="Settings sections"] button')].find(button => button.textContent.includes('Models'))?.click(); true`);
    await pause(1000);
    assert.ok(await cdp.evaluate(`(() => { const row = [...document.querySelectorAll('.handwork-provider-list li')].find(row => row.querySelector('strong')?.textContent.trim() === 'OpenAI'); const button = [...(row?.querySelectorAll('button') || [])].find(button => button.textContent.trim() === 'Connect'); button?.click(); return !!button && !button.disabled; })()`), 'OpenAI key entry must be available in Settings');
    await pause(300);
    await cdp.evaluate(`document.querySelector('#key-openai').focus(); true`);
    await cdp.request('Input.insertText', { text: 'sk-desktop-fixture-key' });
    await pause(300);
    assert.ok(await cdp.evaluate(`(() => { const button = document.querySelector('.handwork-key-form button[type="submit"]'); if (!button || button.disabled) return false; button.click(); return true; })()`), 'Provider key form must submit');
    const session = await cdp.evaluate(`(async () => { const deadline = Date.now() + 30000; let error; while (Date.now() < deadline) { try { return await window.handwork.connect(); } catch (cause) { error = cause; await new Promise(resolve => setTimeout(resolve, 500)); } } throw error; })()`);
    assert.ok(session.sessionId, 'Session was not created');
    await cdp.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await pause(500);
    await cdp.evaluate('window.__smokeEvents = []; window.handwork.onEvent(event => window.__smokeEvents.push(event)); true');
    assert.ok(await cdp.evaluate(`(() => { const input = document.querySelector('textarea'); if (!input || input.disabled) return false; input.focus(); return true; })()`), 'Chat composer must be enabled after provider setup');
    await cdp.request('Input.insertText', { text: 'Reply with the fixture greeting.' });
    await cdp.request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.evaluate(`new Promise((resolve, reject) => { const deadline = Date.now() + 30000; const timer = setInterval(() => { if (document.body.innerText.includes('windows-desktop-smoke-ok')) { clearInterval(timer); resolve(true); } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('Chat response did not render')); } }, 200); })`);
    const events = await cdp.evaluate('window.__smokeEvents');
    assert.match(JSON.stringify(events), /windows-desktop-smoke-ok/);
    assert.ok(requests > 0, 'No request reached the local provider fixture');
    return { sessionId: session.sessionId, requests, eventCount: events.length };
  }));
} finally { await new Promise(resolve => fixture.close(resolve)); }
await writeFile(path.join(output, 'results.json'), JSON.stringify({ architecture: process.arch, executable, restrictedPath, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
