import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { extractFile, uncache } from '@electron/asar';
import yaml from 'js-yaml';
import { Cdp, pause } from './cdp.mjs';

const [executable, targetInstaller, targetVersion, output] = process.argv.slice(2);
await mkdir(output, { recursive: true });
const installer = await readFile(targetInstaller);
const sha512 = createHash('sha512').update(installer).digest('base64');
const initialVersion = JSON.parse(extractFile(path.join(path.dirname(executable), 'resources/app.asar'), 'package.json')).version;
assert.notEqual(initialVersion, targetVersion);
const filename = path.basename(targetInstaller);
const channel = `latest-${process.arch}`;
let downloads = 0;
const fixture = createServer((request, response) => {
  const resource = new URL(request.url, 'http://localhost').pathname;
  if (resource === `/${channel}.yml`) {
    response.end(yaml.dump({ version: targetVersion, files: [{ url: filename, sha512, size: installer.length }], path: filename, sha512 }));
  } else if (resource === `/${filename}`) {
    downloads++;
    response.setHeader('content-length', installer.length);
    createReadStream(targetInstaller).pipe(response);
  } else if (resource.includes('models')) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
  } else response.writeHead(404).end();
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const feed = `http://127.0.0.1:${fixture.address().port}`;
const config = path.join(path.dirname(executable), 'resources/app-update.yml');
const releaseConfig = yaml.load(await readFile(config, 'utf8'));
// Only the test machine's installed feed configuration is changed. The target
// installer is the exact release artifact, verified by electron-updater's SHA512.
const pointToFixture = () => writeFile(config, yaml.dump({ ...releaseConfig, provider: 'generic', url: feed, channel, updaterCacheDirName: `handwork-test-${process.arch}` }));
await pointToFixture();
const env = { ...process.env, PATH: `${process.env.SystemRoot};${process.env.SystemRoot}\\System32`, HOME: path.join(output, 'home'), USERPROFILE: path.join(output, 'home'), HANDWORK_DISABLE_KEYCHAIN: '1', HANDWORK_AUTO_UPGRADE: '0', HANDWORK_E2E_DISABLE_DOTENV: '1' };
for (const key of Object.keys(env)) if (/TOKEN|SECRET|API_KEY|ELECTRON_RUN_AS_NODE/i.test(key)) delete env[key];
Object.assign(env, { OPENAI_API_KEY: 'update-fixture-key', HANDWORK_AUTH_MODE: 'local', HANDWORK_MODEL: 'gpt-test', HANDWORK_OPENAI_BASE_URL: feed });
await mkdir(env.HOME, { recursive: true });
let app;
let cdp;
let log = '';
async function launch(port) {
  app = spawn(executable, [`--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', value => { log += value; });
  app.stderr.on('data', value => { log += value; });
  let page;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()).catch(() => []);
    page = pages.find(page => page.type === 'page' && page.url.startsWith('file:'));
    if (page) break;
    await pause(200);
  }
  assert.ok(page, `No update test renderer: ${log}`);
  cdp = new Cdp(page.webSocketDebuggerUrl);
  while (Date.now() < deadline) {
    try { if (await cdp.evaluate("document.readyState === 'complete' && !!window.handwork && document.body.innerText.includes('Handwork')")) return; }
    catch (error) { if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error; }
    await pause(200);
  }
  throw new Error('Update test UI did not load');
}
const versionOnDisk = () => {
  const archive = path.join(path.dirname(executable), 'resources/app.asar');
  uncache(archive);
  return JSON.parse(extractFile(archive, 'package.json')).version;
};
async function waitFor(action, message, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await action()) return; await pause(300); }
  throw new Error(message);
}
async function click(label) {
  await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === ${JSON.stringify(label)} && !button.disabled)`), `Sidebar action unavailable: ${label}`, 15000);
  assert.ok(await cdp.evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!button || button.disabled) return false; button.click(); return true; })()`), `Sidebar action unavailable: ${label}`);
}
try {
  await launch(9350);
  await waitFor(async () => { try { return !!(await cdp.evaluate('window.handwork.connect()')).sessionId; } catch { return false; } }, 'Initial chat did not connect');
  await cdp.evaluate("document.querySelector('textarea').focus(); true");
  await cdp.request('Input.insertText', { text: 'Unsent draft preserved across the desktop update' });
  await click('Check for updates');
  await waitFor(async () => (await cdp.evaluate('window.handwork.getUpdateState()')).status === 'available', 'Newer release was not discovered');
  await click('Download update');
  await waitFor(async () => (await cdp.evaluate('window.handwork.getUpdateState()')).status === 'downloaded', 'Update did not finish downloading');
  const screenshot = await cdp.request('Page.captureScreenshot');
  await writeFile(path.join(output, 'update-ready.png'), Buffer.from(screenshot.data, 'base64'));
  await click('Restart to update');
  cdp.close(); cdp = null;
  await waitFor(async () => { try { return versionOnDisk() === targetVersion; } catch { return false; } }, 'Installer did not replace the app with the newer version', 120000);
  await waitFor(async () => {
    const processes = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command', "(Get-Process -Name Handwork -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Measure-Object).Count"], { encoding: 'utf8' });
    return Number(processes.stdout.trim()) > 0;
  }, 'Updated app did not relaunch automatically');
  // Relaunch with a debugging port to inspect the installed new version. Normal
  // installer relaunch correctly uses the user's default profile without CLI flags.
  spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/IM', 'Handwork.exe', '/T', '/F']);
  await pause(1500);
  await pointToFixture();
  await launch(9351);
  const info = await cdp.evaluate('window.handwork.settingsInfo()');
  assert.equal(info.appVersion, targetVersion);
  await cdp.evaluate('window.handwork.checkUpdates()');
  await waitFor(async () => (await cdp.evaluate('window.handwork.getUpdateState()')).status === 'idle', 'Updated app did not report up to date');
  assert.ok(downloads > 0);
  await writeFile(path.join(output, 'update-result.json'), JSON.stringify({ initialVersion, installedVersion: info.appVersion, architecture: info.architecture, downloads, installerSha256: createHash('sha256').update(installer).digest('hex'), sidebarDownloadAndRestart: true, automaticRelaunch: true }, null, 2));
  console.log(`PASS sidebar update ${initialVersion} -> ${info.appVersion}, ${info.architecture}, automatic relaunch`);
} finally {
  cdp?.close();
  if (app?.pid) spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/IM', 'Handwork.exe', '/T', '/F']);
  await writeFile(path.join(output, 'updater.log'), log);
  await new Promise(resolve => fixture.close(resolve));
}
