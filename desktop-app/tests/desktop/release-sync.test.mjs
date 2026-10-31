import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('release sync copies tracked source, removes deleted files, and installs the Electron release workflow', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'handwork-release-sync-'));
  const git = args => execFileSync('git', args, { cwd: directory, stdio: 'pipe' });
  try {
    git(['init']);
    git(['config', 'user.name', 'Release Test']);
    git(['config', 'user.email', 'release@example.test']);
    git(['remote', 'add', 'origin', 'https://github.com/loveconnor/handwork.git']);
    mkdirSync(path.join(directory, 'desktop-app'), { recursive: true });
    mkdirSync(path.join(directory, '.github/workflows'), { recursive: true });
    writeFileSync(path.join(directory, 'build.zig'), 'engine fixture');
    writeFileSync(path.join(directory, 'desktop-app/deleted-source.txt'), 'obsolete');
    writeFileSync(path.join(directory, '.github/workflows/desktop-release.yml'), 'signed release fixture');
    git(['add', '.']);
    git(['commit', '-m', 'fixture']);
    execFileSync(process.execPath, ['scripts/sync-release-source.mjs', directory]);
    assert.equal(existsSync(path.join(directory, 'desktop-app/deleted-source.txt')), false);
    assert.deepEqual(readFileSync(path.join(directory, 'desktop-app/package.json')), readFileSync('package.json'));
    assert.equal(existsSync(path.join(directory, 'desktop-app/scripts/ci-macos-keychain.mjs')), true);
    assert.equal(existsSync(path.join(directory, 'desktop-app/.github')), false);
    assert.equal(existsSync(path.join(directory, 'desktop-app/node_modules')), false);
    assert.equal(readFileSync(path.join(directory, '.github/workflows/desktop-release.yml'), 'utf8'), readFileSync('scripts/ci/desktop-release.yml', 'utf8')); 
    // Run the workflow parser test in the same layout as the signed release jobs.
    execFileSync(process.execPath, ['--test', '--test-name-pattern=push destinations that start release workflows', 'tests/desktop/git-service.test.mjs'], {
      cwd: path.join(directory, 'desktop-app'), stdio: 'pipe',
    });
    assert.throws(() => execFileSync(process.execPath, ['scripts/sync-release-source.mjs', directory], { stdio: 'pipe' }), /uncommitted changes/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('release sync excludes a nested destination checkout and other Git directory entries', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'handwork-nested-release-sync-'));
  const source = path.join(directory, 'source');
  const engine = path.join(source, 'release-engine');
  const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  const init = cwd => {
    mkdirSync(cwd, { recursive: true });
    git(cwd, ['init']);
    git(cwd, ['config', 'user.name', 'Release Test']);
    git(cwd, ['config', 'user.email', 'release@example.test']);
  };
  try {
    init(source);
    mkdirSync(path.join(source, 'scripts/ci'), { recursive: true });
    writeFileSync(path.join(source, 'scripts/sync-release-source.mjs'), readFileSync('scripts/sync-release-source.mjs'));
    writeFileSync(path.join(source, 'scripts/ci/desktop-release.yml'), readFileSync('scripts/ci/desktop-release.yml'));
    writeFileSync(path.join(source, 'tracked.txt'), 'tracked source');
    writeFileSync(path.join(source, 'deleted.txt'), 'deleted locally');
    git(source, ['add', '.']);
    git(source, ['commit', '-m', 'source fixture']);
    rmSync(path.join(source, 'deleted.txt'));
    writeFileSync(path.join(source, 'new.txt'), 'untracked source');

    init(engine);
    git(engine, ['remote', 'add', 'origin', 'git@github.com:loveconnor/handwork.git']);
    writeFileSync(path.join(engine, 'build.zig'), 'engine fixture');
    mkdirSync(path.join(engine, 'desktop-app'), { recursive: true });
    writeFileSync(path.join(engine, 'desktop-app/obsolete.txt'), 'obsolete');
    git(engine, ['add', '.']);
    git(engine, ['commit', '-m', 'engine fixture']);

    const other = path.join(source, 'z-other-checkout');
    init(other);
    writeFileSync(path.join(other, 'private.txt'), 'another checkout');
    git(other, ['add', '.']);
    git(other, ['commit', '-m', 'other fixture']);
    const candidates = git(source, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).toString().split('\0');
    assert.ok(candidates.includes('release-engine/'), 'fixture reproduces the CI directory entry');
    assert.ok(candidates.includes('z-other-checkout/'));

    execFileSync(process.execPath, ['scripts/sync-release-source.mjs', 'release-engine'], { cwd: source, stdio: 'pipe' });
    assert.equal(readFileSync(path.join(engine, 'desktop-app/tracked.txt'), 'utf8'), 'tracked source');
    assert.equal(readFileSync(path.join(engine, 'desktop-app/new.txt'), 'utf8'), 'untracked source');
    for (const excluded of ['release-engine', 'z-other-checkout', 'obsolete.txt', 'deleted.txt']) {
      assert.equal(existsSync(path.join(engine, 'desktop-app', excluded)), false, excluded);
    }
    assert.deepEqual(readFileSync(path.join(engine, '.github/workflows/desktop-release.yml')), readFileSync('scripts/ci/desktop-release.yml'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
