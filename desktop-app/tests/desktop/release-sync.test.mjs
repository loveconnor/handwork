import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('release sync copies tracked source, removes deleted files, and preserves the engine workflow', () => {
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
    assert.equal(readFileSync(path.join(directory, '.github/workflows/desktop-release.yml'), 'utf8'), 'signed release fixture');
    // Run the workflow parser test in the same layout as the signed release jobs.
    execFileSync(process.execPath, ['--test', '--test-name-pattern=push destinations that start release workflows', 'tests/desktop/git-service.test.mjs'], {
      cwd: path.join(directory, 'desktop-app'), stdio: 'pipe',
    });
    assert.throws(() => execFileSync(process.execPath, ['scripts/sync-release-source.mjs', directory], { stdio: 'pipe' }), /uncommitted changes/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
