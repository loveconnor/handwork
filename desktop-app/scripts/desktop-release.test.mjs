import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeReleaseManifests, releaseTargets, sha256 } from './desktop-release-artifacts.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const version = '0.1.42';
const parts = Object.entries(releaseTargets).map(([target, spec]) => ({
  target, version, file: `Handwork-${version}-${spec.platform}${spec.extension}`, signature: 'signed', sha256: 'a'.repeat(64),
}));
test('publishes one immutable signed URL for every supported platform', () => {
  const manifest = mergeReleaseManifests(parts, version);
  assert.deepEqual(Object.keys(manifest.platforms), ['darwin-aarch64', 'windows-x86_64', 'windows-aarch64']);
  for (const entry of Object.values(manifest.platforms)) {
    assert.ok(entry.url.startsWith(`https://github.com/loveconnor/handwork/releases/download/desktop-v${version}/`));
    assert.equal(entry.signature, 'signed');
  }
});
test('refuses incomplete, duplicated, unsigned, wrong-version, and unsafe releases', () => {
  assert.throws(() => mergeReleaseManifests(parts.slice(1), version), /Missing release target/);
  assert.throws(() => mergeReleaseManifests([...parts, parts[0]], version), /Duplicate/);
  for (const patch of [{ signature: '' }, { version: '0.1.1' }, { file: '../bad.exe' }, { sha256: '' }]) {
    assert.throws(() => mergeReleaseManifests([{ ...parts[0], ...patch }, ...parts.slice(1)], version));
  }
});
test('collects Windows installers without losing their architecture or signature', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'handwork-release-test-'));
  try {
    for (const target of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) {
      const bundle = path.join(dir, 'target', target, 'release/bundle/nsis');
      await mkdir(bundle, { recursive: true });
      await writeFile(path.join(bundle, 'Handwork-setup.exe'), 'installer');
      await writeFile(path.join(bundle, 'Handwork-setup.exe.sig'), 'signed');
      execFileSync(process.execPath, [path.join(root, 'scripts/collect-desktop-release.mjs')], {
        cwd: dir, env: { ...process.env, DESKTOP_VERSION: version, DESKTOP_TARGET: target },
      });
      const spec = releaseTargets[target];
      const part = JSON.parse(await readFile(path.join(dir, 'release-assets', `${spec.platform}.json`), 'utf8'));
      assert.equal(part.target, target);
      assert.equal(part.sha256, await sha256(path.join(dir, 'release-assets', part.file)));
      assert.equal(await readFile(path.join(dir, 'release-assets', `${part.file}.sig`), 'utf8'), 'signed');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('collects the Mac installer and signed app archive, excluding the .app tree', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'handwork-release-test-'));
  try {
    const target = 'aarch64-apple-darwin';
    const bundle = path.join(dir, 'target', target, 'release/bundle');
    await mkdir(path.join(bundle, 'macos/Handwork.app/Contents'), { recursive: true });
    await mkdir(path.join(bundle, 'dmg'), { recursive: true });
    await writeFile(path.join(bundle, 'macos/Handwork.app.tar.gz'), 'app');
    await writeFile(path.join(bundle, 'macos/Handwork.app.tar.gz.sig'), 'signed');
    await writeFile(path.join(bundle, 'dmg/Handwork.dmg'), 'dmg');
    execFileSync(process.execPath, [path.join(root, 'scripts/collect-desktop-release.mjs')], { cwd: dir, env: { ...process.env, DESKTOP_VERSION: version, DESKTOP_TARGET: target } });
    assert.equal(await readFile(path.join(dir, 'release-assets', `Handwork-${version}-darwin-aarch64.dmg`), 'utf8'), 'dmg');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('syncs the Tauri app and release workflow together, removing stale Electron source', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'handwork-sync-test-'));
  const source = path.join(dir, 'source');
  const engine = path.join(dir, 'engine');
  const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const commit = cwd => {
    git(cwd, ['add', '.']);
    git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture']);
  };
  try {
    await mkdir(path.join(source, 'scripts/ci'), { recursive: true });
    await mkdir(path.join(source, '.github/workflows'), { recursive: true });
    await mkdir(path.join(engine, 'desktop-app/electron'), { recursive: true });
    await mkdir(path.join(engine, '.github/workflows'), { recursive: true });
    for (const cwd of [source, engine]) git(cwd, ['init']);
    git(engine, ['remote', 'add', 'origin', 'git@github.com:loveconnor/handwork.git']);
    await copyFile(path.join(root, 'scripts/sync-release-source.mjs'), path.join(source, 'scripts/sync-release-source.mjs'));
    await writeFile(path.join(source, 'scripts/ci/desktop-release.yml'), 'tauri release');
    await writeFile(path.join(source, '.github/workflows/desktop-release.yml'), 'source relay');
    await writeFile(path.join(source, 'Cargo.toml'), '[workspace]');
    await writeFile(path.join(engine, 'build.zig'), '// engine');
    await writeFile(path.join(engine, 'desktop-app/electron/main.mjs'), '// stale');
    await writeFile(path.join(engine, '.github/workflows/desktop-release.yml'), 'electron release');
    commit(source);
    commit(engine);
    execFileSync(process.execPath, [path.join(source, 'scripts/sync-release-source.mjs'), engine], { stdio: 'pipe' });
    assert.equal(await readFile(path.join(engine, '.github/workflows/desktop-release.yml'), 'utf8'), 'tauri release');
    assert.equal(await readFile(path.join(engine, 'desktop-app/Cargo.toml'), 'utf8'), '[workspace]');
    await assert.rejects(readFile(path.join(engine, 'desktop-app/electron/main.mjs')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(engine, 'desktop-app/.github/workflows/desktop-release.yml')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
