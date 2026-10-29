import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderUpdates, compareVersions, parseVersion } from '../../electron/provider-updates.mjs';
import { validateArguments } from '../../electron/ipc.mjs';

const feed = versions => async url => {
  const latest = url.includes('opencode-ai') ? versions.opencode : url.includes('codex') ? versions.codex : versions.ollama;
  return { ok: latest != null, json: async () => url.includes('github') ? { tag_name: `v${latest}` } : { version: latest } };
};

/** A bin directory of executables, plus an npm-style install whose launcher is a symlink. */
function installs() {
  // Real path: on macOS the temp directory is a symlink into /private.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'provider-updates-')));
  const bin = path.join(root, 'bin');
  const pkg = path.join(root, 'lib/node_modules/@openai/codex');
  mkdirSync(bin, { recursive: true }); mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
  writeFileSync(path.join(pkg, 'bin/codex.js'), ''); chmodSync(path.join(pkg, 'bin/codex.js'), 0o755);
  symlinkSync(path.join(pkg, 'bin/codex.js'), path.join(bin, 'codex'));
  for (const name of ['opencode', 'ollama', 'npm']) { writeFileSync(path.join(bin, name), ''); chmodSync(path.join(bin, name), 0o755); }
  return { root, bin };
}

test('versions parse from each tool’s own wording and compare numerically', () => {
  assert.equal(parseVersion('codex-cli 0.165.0-alpha.1.2'), '0.165.0');
  assert.equal(parseVersion('ollama version is 0.40.10'), '0.40.10');
  assert.equal(parseVersion('v0.40.12'), '0.40.12');
  assert.equal(parseVersion('Error: Missing optional dependency'), null);
  assert.equal(compareVersions('1.19.10', '1.19.9'), 1);
  assert.equal(compareVersions('0.40.10', '0.40.12'), -1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
});

test('only connected providers with newer releases are offered, a broken npm install as a reinstall', async () => {
  const { root, bin } = installs();
  const versions = { codex: null, opencode: '1.19.4', ollama: '0.40.10' };
  const execFile = (command, args, options, done) => {
    const name = path.basename(command);
    if (name === 'codex') return done(new Error('exit 1'), '', 'Error: Missing optional dependency @openai/codex-darwin-arm64');
    done(null, name === 'ollama' ? `ollama version is ${versions.ollama}` : versions[name], '');
  };
  const updates = new ProviderUpdates({ directories: [bin], execFile, fetch: feed({ codex: '0.165.0', opencode: '1.19.5', ollama: '0.40.12' }) });
  const found = await updates.check(['codex', 'opencode', 'ollama', 'anthropic']);
  assert.deepEqual(found, [
    { provider: 'codex', name: 'Codex CLI', latest: '0.165.0', action: 'reinstall', installed: null },
    { provider: 'opencode', name: 'OpenCode', latest: '1.19.5', action: 'update', installed: '1.19.4' },
    { provider: 'ollama', name: 'Ollama', latest: '0.40.12', action: 'download', installed: '0.40.10' },
  ]);
  assert.equal(await updates.check(['codex']), found, 'one check per launch');
  assert.equal(await updates.npmPrefix({ npm: '@openai/codex' }, path.join(bin, 'codex')), root);
});

test('current software and failed release lookups offer nothing', async () => {
  const { bin } = installs();
  const execFile = (command, args, options, done) => done(null, '9.9.9', '');
  const current = new ProviderUpdates({ directories: [bin], execFile, fetch: feed({ codex: '1.0.0', opencode: '1.0.0', ollama: '1.0.0' }) });
  assert.deepEqual(await current.check(['codex', 'opencode', 'ollama']), []);
  const offline = new ProviderUpdates({ directories: [bin], execFile, fetch: async () => { throw new Error('offline'); } });
  assert.deepEqual(await offline.check(['codex', 'opencode', 'ollama']), []);
});

test('npm installs update into their own prefix; native installs run their updater; success is the new version', async () => {
  const { root, bin } = installs();
  const calls = [];
  let opencode = '1.19.4', codex = null;
  const execFile = (command, args, options, done) => {
    calls.push([path.basename(command), ...args]);
    if (args[0] === '--version') return path.basename(command) === 'codex' ? (codex ? done(null, codex, '') : done(new Error('broken'), '', 'broken')) : done(null, opencode, '');
    if (path.basename(command) === 'npm') codex = '0.165.0';
    if (args[0] === 'upgrade') opencode = '1.19.5';
    done(null, '', '');
  };
  const opened = [];
  const updates = new ProviderUpdates({ directories: [bin], execFile, fetch: feed({ codex: '0.165.0', opencode: '1.19.5', ollama: '0.40.12' }), openExternal: async url => opened.push(url) });
  assert.deepEqual(await updates.update('codex'), { version: '0.165.0' });
  assert.deepEqual(calls.find(call => call[0] === 'npm'), ['npm', 'install', '--global', '--prefix', root, '@openai/codex@latest', '--no-audit', '--no-fund']);
  assert.deepEqual(await updates.update('opencode'), { version: '1.19.5' });
  assert.ok(calls.some(call => call[0] === 'opencode' && call[1] === 'upgrade'));
  assert.deepEqual(await updates.update('ollama'), { opened: true });
  assert.deepEqual(opened, ['https://ollama.com/download']);
});

test('an updater that exits cleanly without updating is reported, not trusted', async () => {
  const { bin } = installs();
  const execFile = (command, args, options, done) => done(null, args[0] === '--version' ? '1.19.4' : '', '');
  const updates = new ProviderUpdates({ directories: [bin], execFile, fetch: feed({ opencode: '1.19.5' }) });
  await assert.rejects(updates.update('opencode'), /OpenCode is still 1\.19\.4/);
});

test('update IPC is limited to provider ids and updatable software', () => {
  validateArguments('providerUpdates', [['codex', 'ollama_cloud']]);
  validateArguments('updateProvider', ['opencode']);
  for (const args of [[], ['codex'], [['../x']], [Array(33).fill('codex')]]) assert.throws(() => validateArguments('providerUpdates', args), /Invalid desktop API arguments/);
  for (const args of [[], ['anthropic'], ['npm'], [['codex']]]) assert.throws(() => validateArguments('updateProvider', args), /Invalid desktop API arguments/);
  assert.match(readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8'), /'providerUpdates', 'updateProvider'/);
});
