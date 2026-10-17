import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitService, classifyGitError, progressOf, redact, validRefName, validRepositoryPath, workflowRunsOnPush } from '../../electron/git-service.mjs';
import { parseCommitMessage } from '../../electron/commit-message.mjs';
import { validateArguments } from '../../electron/ipc.mjs';
import { DesktopBackend } from '../../electron/backend.mjs';

const CONFIG = '[user]\n\tname = Handwork Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[advice]\n\tdetachedHead = false\n';

/** A project with an `origin` bare remote, isolated from the person's Git configuration. */
function sandbox(config = CONFIG) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'handwork-git-')));
  writeFileSync(path.join(root, 'gitconfig'), config);
  const env = { GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', HOME: root, XDG_CONFIG_HOME: path.join(root, 'xdg') };
  const shell = { ...process.env, ...env };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: shell, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '--bare', '--quiet', remote);
  const repo = path.join(root, 'project');
  mkdirSync(repo);
  git(repo, 'init', '--quiet');
  git(repo, 'remote', 'add', 'origin', remote);
  const events = [];
  const service = new GitService({ env, emit: event => events.push(event) });
  const write = (file, text) => { mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); writeFileSync(path.join(repo, file), text); };
  /** A second person's clone of the remote. */
  const clone = () => { const other = path.join(root, `clone-${Math.random().toString(36).slice(2)}`); git(root, 'clone', '--quiet', remote, other); return other; };
  return { root, repo, remote, git, service, events, write, clone, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const reviewed = state => ({ repository: state.repository, branch: state.head.branch, head: state.head.oid, index: state.index });
const message = (summary, description = '') => ({ summary, description });

async function firstCommit(box, summary = 'Initial commit') {
  box.write('README.md', '# Project\n');
  let state = await box.service.state(box.repo);
  await box.service.stage(box.repo, ['README.md']);
  state = await box.service.state(box.repo);
  const result = await box.service.commit(box.repo, message(summary), reviewed(state));
  assert.equal(result.ok, true, result.error?.message);
  return result.state;
}

test('branch, partial staging, commit, publish, push, fetch, pull and history all work inside Handwork', async () => {
  const box = sandbox();
  try {
    // First commit on an unborn branch.
    box.write('README.md', '# Project\n');
    let state = await box.service.state(box.repo);
    assert.equal(state.kind, 'repository');
    assert.equal(state.head.unborn, true);
    assert.equal(state.head.branch, 'main');
    assert.deepEqual(state.unstaged.map(change => [change.path, change.status, change.untracked]), [['README.md', '?', true]]);
    assert.equal((await box.service.stage(box.repo, ['README.md'])).ok, true);
    state = await box.service.state(box.repo);
    assert.deepEqual(state.staged.map(change => change.path), ['README.md']);
    let result = await box.service.commit(box.repo, message('Initial commit'), reviewed(state));
    assert.equal(result.ok, true, result.error?.message);
    assert.match(result.commit.short, /^[0-9a-f]{7,}$/);
    assert.equal(result.state.head.unborn, false);
    assert.equal(result.state.publish.reason, 'no-upstream');
    assert.equal((await box.service.publish(box.repo, 'origin')).ok, true);

    // Create a branch from HEAD; it needs publishing.
    result = await box.service.createBranch(box.repo, 'feature/login');
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.state.head.branch, 'feature/login');
    assert.equal(result.state.publish?.reason, 'no-upstream');
    assert.equal(result.state.push, null);

    // Edit two files, stage one, then edit the staged file again.
    box.write('README.md', '# Project\n\nSign in with email.\n');
    box.write('src/login.js', 'export const login = () => true;\n');
    assert.equal((await box.service.stage(box.repo, ['README.md'])).ok, true);
    box.write('README.md', '# Project\n\nSign in with email.\nAnd with a passkey.\n');
    state = await box.service.state(box.repo);
    assert.deepEqual(state.staged.map(change => [change.path, change.partial]), [['README.md', true]]);
    assert.deepEqual(state.unstaged.map(change => [change.path, change.partial]).sort(), [['README.md', true], ['src/login.js', false]]);
    const staged = await box.service.fileDiff(box.repo, 'README.md', 'staged', 3);
    const unstaged = await box.service.fileDiff(box.repo, 'README.md', 'unstaged', 3);
    assert.match(staged.sections[0].patch, /\+Sign in with email\./);
    assert.doesNotMatch(staged.sections[0].patch, /passkey/);
    assert.match(unstaged.sections[0].patch, /\+And with a passkey\./);
    assert.equal((await box.service.fileDiff(box.repo, 'src/login.js', 'unstaged', 3)).sections[0].label, 'Untracked');

    // The commit records exactly the staged contents.
    result = await box.service.commit(box.repo, message('Document email sign-in', 'Explains the new flow.'), reviewed(state));
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(box.git(box.repo, 'show', 'HEAD:README.md'), '# Project\n\nSign in with email.');
    assert.equal(box.git(box.repo, 'log', '-1', '--format=%B'), 'Document email sign-in\n\nExplains the new flow.');
    assert.match(readFileSync(path.join(box.repo, 'README.md'), 'utf8'), /passkey/);
    assert.deepEqual(result.state.unstaged.map(change => change.path).sort(), ['README.md', 'src/login.js']);
    assert.equal(result.state.publish.outgoing, 1);

    // Publish sets tracking on the chosen remote.
    result = await box.service.publish(box.repo, 'origin');
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.destination, 'origin/feature/login');
    assert.equal(result.state.upstream.name, 'origin/feature/login');
    assert.deepEqual([result.state.push.remote, result.state.push.branch, result.state.push.outgoing], ['origin', 'feature/login', 0]);
    assert.equal(box.git(box.remote, 'rev-parse', 'feature/login'), box.git(box.repo, 'rev-parse', 'HEAD'));

    // Another commit, then push to the displayed destination.
    assert.equal((await box.service.stageAll(box.repo)).ok, true);
    state = await box.service.state(box.repo);
    result = await box.service.commit(box.repo, message('Add login'), reviewed(state));
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.state.push.outgoing, 1);
    let log = await box.service.log(box.repo, 10);
    assert.deepEqual(log.commits.map(commit => [commit.subject, commit.local]), [['Add login', true], ['Document email sign-in', false], ['Initial commit', false]]);
    result = await box.service.push(box.repo, { remote: 'origin', branch: 'feature/login' });
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.state.push.outgoing, 0);
    assert.ok(box.events.some(event => event.params.operation === 'push' && event.params.phase === 'start'));
    assert.ok(box.events.some(event => event.params.operation === 'push' && event.params.phase === 'end' && event.params.ok));

    // Someone else pushes; fetch shows it incoming without touching files, pull fast-forwards.
    const other = box.clone();
    box.git(other, 'switch', '--quiet', 'feature/login');
    writeFileSync(path.join(other, 'CHANGELOG.md'), 'Login\n');
    box.git(other, 'add', 'CHANGELOG.md');
    box.git(other, 'commit', '--quiet', '-m', 'Add changelog');
    box.git(other, 'push', '--quiet');
    result = await box.service.fetch(box.repo);
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.state.behind, 1);
    assert.ok(result.state.fetchedAt > 0);
    log = await box.service.log(box.repo, 10);
    assert.deepEqual(log.incoming.map(commit => commit.subject), ['Add changelog']);
    result = await box.service.pull(box.repo);
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(result.state.behind, 0);
    assert.equal(readFileSync(path.join(box.repo, 'CHANGELOG.md'), 'utf8'), 'Login\n');

    // History: messages, authors, files and diffs.
    log = await box.service.log(box.repo, 10);
    assert.deepEqual(log.commits.map(commit => commit.subject), ['Add changelog', 'Add login', 'Document email sign-in', 'Initial commit']);
    assert.equal(log.commits[1].author, 'Handwork Test');
    const details = await box.service.commitDetails(box.repo, log.commits[1].oid);
    assert.deepEqual(details.files.map(file => [file.path, file.status]).sort(), [['README.md', 'M'], ['src/login.js', 'A']]);
    const diff = await box.service.commitFileDiff(box.repo, log.commits[1].oid, 'src/login.js', 3);
    assert.match(diff.sections[0].patch, /\+export const login/);
    const root = await box.service.commitDetails(box.repo, log.commits[3].oid);
    assert.deepEqual(root.files.map(file => file.path), ['README.md']);
    await assert.rejects(box.service.commitFileDiff(box.repo, log.commits[1].oid, 'CHANGELOG.md', 3), /not part of the commit/);
  } finally { box.cleanup(); }
});

test('a rejected push explains how to recover, and a diverged pull refuses to merge', async () => {
  const box = sandbox();
  try {
    await firstCommit(box);
    await box.service.publish(box.repo, 'origin');
    const other = box.clone();
    writeFileSync(path.join(other, 'remote.txt'), 'theirs\n');
    box.git(other, 'add', '.');
    box.git(other, 'commit', '--quiet', '-m', 'Their change');
    box.git(other, 'push', '--quiet');
    box.write('local.txt', 'mine\n');
    await box.service.stageAll(box.repo);
    const state = await box.service.state(box.repo);
    assert.equal((await box.service.commit(box.repo, message('My change'), reviewed(state))).ok, true);
    const before = box.git(box.remote, 'rev-parse', 'main');
    const push = await box.service.push(box.repo, { remote: 'origin', branch: 'main' });
    assert.equal(push.ok, false);
    assert.equal(push.error.code, 'rejected');
    assert.ok(push.error.actions.includes('pull'));
    assert.match(push.error.message, /origin\/main has commits you don't have/);
    assert.equal(box.git(box.remote, 'rev-parse', 'main'), before, 'nothing on the remote changed');
    const pull = await box.service.pull(box.repo);
    assert.equal(pull.ok, false);
    assert.equal(pull.error.code, 'diverged');
    assert.match(pull.error.message, /\(1 local, 1 incoming\)/);
    assert.equal(box.git(box.repo, 'log', '-1', '--format=%s'), 'My change', 'no merge commit was created');
  } finally { box.cleanup(); }
});

test('a failing commit hook keeps the staged changes and reports its output', async () => {
  const box = sandbox();
  try {
    await firstCommit(box);
    const hook = path.join(box.repo, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "lint: missing semicolon in app.js" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    box.write('app.js', 'let a = 1\n');
    await box.service.stage(box.repo, ['app.js']);
    const state = await box.service.state(box.repo);
    const result = await box.service.commit(box.repo, message('Add app'), reviewed(state));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'hook');
    assert.match(result.error.detail, /missing semicolon/);
    assert.deepEqual(result.state.staged.map(change => change.path), ['app.js']);
    assert.equal(box.git(box.repo, 'log', '-1', '--format=%s'), 'Initial commit');
    // Hooks stay enabled: fixing what it reported lets the commit through.
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    assert.equal((await box.service.commit(box.repo, message('Add app'), reviewed(result.state))).ok, true);
  } finally { box.cleanup(); }
});

test('a commit is refused when the staged contents or branch changed after review', async () => {
  const box = sandbox();
  try {
    await firstCommit(box);
    box.write('a.txt', 'a\n');
    box.write('b.txt', 'b\n');
    await box.service.stage(box.repo, ['a.txt']);
    const state = await box.service.state(box.repo);
    box.git(box.repo, 'add', 'b.txt');
    const result = await box.service.commit(box.repo, message('Add a'), reviewed(state));
    assert.equal(result.ok, false);
    assert.equal(result.changed, true);
    assert.equal(result.error.code, 'changed');
    assert.deepEqual(result.state.staged.map(change => change.path).sort(), ['a.txt', 'b.txt']);
    assert.equal(box.git(box.repo, 'log', '-1', '--format=%s'), 'Initial commit');
    // Content edits to an already staged file count as a change too.
    const fresh = result.state;
    box.write('a.txt', 'a changed\n');
    box.git(box.repo, 'add', 'a.txt');
    assert.equal((await box.service.commit(box.repo, message('Add a'), reviewed(fresh))).changed, true);
  } finally { box.cleanup(); }
});

test('missing identity, detached HEAD, repository locks and conflicts produce actionable errors', async () => {
  const anonymous = sandbox('[init]\n\tdefaultBranch = main\n[user]\n\tuseConfigOnly = true\n');
  try {
    anonymous.write('a.txt', 'a\n');
    await anonymous.service.stage(anonymous.repo, ['a.txt']);
    const state = await anonymous.service.state(anonymous.repo);
    assert.equal(state.identity, null);
    const result = await anonymous.service.commit(anonymous.repo, message('Add a'), reviewed(state));
    assert.equal(result.error.code, 'identity');
    assert.match(result.error.detail, /git config --global user\.email/);
    assert.ok(result.error.actions.includes('terminal'));
  } finally { anonymous.cleanup(); }

  const box = sandbox();
  try {
    await firstCommit(box);
    // Detached HEAD: committing is blocked until a branch exists.
    box.git(box.repo, 'switch', '--quiet', '--detach', 'HEAD');
    box.write('a.txt', 'a\n');
    await box.service.stage(box.repo, ['a.txt']);
    let state = await box.service.state(box.repo);
    assert.equal(state.head.detached, true);
    let result = await box.service.commit(box.repo, message('Add a'), reviewed(state));
    assert.equal(result.error.code, 'detached');
    assert.deepEqual(result.error.actions, ['branch']);
    result = await box.service.createBranch(box.repo, 'rescue');
    assert.equal(result.ok, true);
    assert.deepEqual(result.state.staged.map(change => change.path), ['a.txt'], 'staged work comes along');
    assert.equal((await box.service.createBranch(box.repo, 'rescue')).error.code, 'branch-exists');
    assert.equal((await box.service.createBranch(box.repo, 'bad..name')).error.code, 'invalid-branch');

    // Another Git process holds the index lock.
    writeFileSync(path.join(box.repo, '.git', 'index.lock'), '');
    result = await box.service.unstage(box.repo, ['a.txt']);
    assert.equal(result.error.code, 'lock');
    assert.match(result.error.message, /index\.lock/);
    rmSync(path.join(box.repo, '.git', 'index.lock'));

    // Unresolved conflicts block the commit; markers block marking the file resolved.
    state = await box.service.state(box.repo);
    assert.equal((await box.service.commit(box.repo, message('Add a'), reviewed(state))).ok, true);
    box.git(box.repo, 'switch', '--quiet', '-c', 'theirs', 'main');
    box.write('README.md', 'theirs\n');
    box.git(box.repo, 'commit', '--quiet', '-am', 'Theirs');
    box.git(box.repo, 'switch', '--quiet', 'rescue');
    box.write('README.md', 'ours\n');
    box.git(box.repo, 'commit', '--quiet', '-am', 'Ours');
    assert.throws(() => box.git(box.repo, 'merge', 'theirs'));
    state = await box.service.state(box.repo);
    assert.equal(state.operation, 'merge');
    assert.deepEqual(state.conflicts.map(change => change.path), ['README.md']);
    result = await box.service.commit(box.repo, message('Merge'), reviewed(state));
    assert.equal(result.error.code, 'conflicts');
    result = await box.service.stage(box.repo, ['README.md']);
    assert.equal(result.error.code, 'conflicts');
    assert.match(result.error.message, /conflict markers/);
    box.write('README.md', 'both\n');
    result = await box.service.stage(box.repo, ['README.md']);
    assert.equal(result.ok, true);
    assert.equal(result.state.conflicts.length, 0);
    result = await box.service.commit(box.repo, message('Merge theirs'), reviewed(result.state));
    assert.equal(result.ok, true, result.error?.message);
    assert.equal(box.git(box.repo, 'rev-list', '--count', '--parents', '-1', 'HEAD').length > 0, true);
  } finally { box.cleanup(); }
});

test('a blocked branch switch explains itself and leaves uncommitted work alone', async () => {
  const box = sandbox();
  try {
    await firstCommit(box);
    box.git(box.repo, 'switch', '--quiet', '-c', 'other');
    box.write('README.md', 'other\n');
    box.git(box.repo, 'commit', '--quiet', '-am', 'Other');
    box.git(box.repo, 'switch', '--quiet', 'main');
    box.write('README.md', 'unsaved work\n');
    const result = await box.service.switchBranch(box.repo, 'other');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'dirty');
    assert.match(result.error.message, /README\.md/);
    assert.match(result.error.message, /never discards or stashes/);
    assert.equal(result.state.head.branch, 'main');
    assert.equal(readFileSync(path.join(box.repo, 'README.md'), 'utf8'), 'unsaved work\n');
    assert.equal(box.git(box.repo, 'stash', 'list'), '');
    const branches = await box.service.branches(box.repo);
    assert.deepEqual(branches.branches.map(branch => [branch.name, branch.current]).sort(), [['main', true], ['other', false]]);
    assert.equal((await box.service.switchBranch(box.repo, 'missing')).error.code, 'missing-branch');
  } finally { box.cleanup(); }
});

test('a branch tracking a differently named upstream must be published, not pushed onto it', async () => {
  const box = sandbox();
  try {
    await firstCommit(box);
    await box.service.publish(box.repo, 'origin');
    box.git(box.repo, 'switch', '--quiet', '-c', 'feature', 'origin/main');
    box.write('f.txt', 'f\n');
    box.git(box.repo, 'add', 'f.txt');
    box.git(box.repo, 'commit', '--quiet', '-m', 'Feature');
    const state = await box.service.state(box.repo);
    assert.equal(state.upstream.name, 'origin/main');
    assert.equal(state.push, null);
    assert.equal(state.publish.reason, 'mismatch');
    const before = box.git(box.remote, 'rev-parse', 'main');
    assert.equal((await box.service.push(box.repo, { remote: 'origin', branch: 'main' })).error.code, 'no-upstream');
    assert.equal(box.git(box.remote, 'rev-parse', 'main'), before);
    const result = await box.service.publish(box.repo, 'origin');
    assert.equal(result.ok, true);
    assert.equal(result.state.upstream.name, 'origin/feature');
  } finally { box.cleanup(); }
});

test('a project in a subfolder sees, and commits, the whole repository', async () => {
  const box = sandbox();
  try {
    await firstCommit(box);
    box.write('packages/app/index.js', 'app\n');
    box.write('shared/util.js', 'util\n');
    const project = path.join(box.repo, 'packages', 'app');
    await box.service.stageAll(project);
    const state = await box.service.state(project);
    assert.equal(state.scope, 'packages/app');
    assert.equal(state.repository, box.repo);
    assert.deepEqual(state.staged.map(change => [change.path, change.inProject]).sort(), [['packages/app/index.js', true], ['shared/util.js', false]]);
    assert.equal((await box.service.commit(project, message('Add app and util'), reviewed(state))).ok, true);
    assert.deepEqual(box.git(box.repo, 'show', '--format=', '--name-only', 'HEAD').split('\n').sort(), ['packages/app/index.js', 'shared/util.js']);
  } finally { box.cleanup(); }
});

test('mutations on one repository run one at a time across callers', async () => {
  const box = sandbox();
  try {
    await firstCommit(box);
    const order = [];
    const slow = name => box.service.mutate(box.repo, 'stage', async () => {
      order.push(`${name}:start`);
      assert.equal(box.service.busy.get(box.repo), 'stage');
      await new Promise(resolve => setTimeout(resolve, 30));
      order.push(`${name}:end`);
      return { ok: true };
    });
    const results = await Promise.all([slow('first'), slow('second'), slow('third')]);
    assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end', 'third:start', 'third:end']);
    assert.ok(results.every(result => result.ok && result.state.kind === 'repository'), 'every operation refreshes status');
    assert.equal(box.service.locks.size, 0);
    assert.equal(box.service.busy.size, 0);
    // A failing operation does not block the next one.
    const failed = await box.service.mutate(box.repo, 'fetch', async () => { throw Object.assign(new Error('x'), { stderr: 'fatal: Could not resolve host: example.invalid' }); });
    assert.equal(failed.error.code, 'network');
    assert.equal((await box.service.mutate(box.repo, 'stage', async () => ({ ok: true }))).ok, true);
  } finally { box.cleanup(); }
});

test('unreachable remotes offer retry and a terminal', async () => {
  const box = sandbox();
  try {
    await firstCommit(box);
    box.git(box.repo, 'remote', 'set-url', 'origin', path.join(box.root, 'missing.git'));
    const result = await box.service.publish(box.repo, 'origin');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'network');
    assert.deepEqual(result.error.actions, ['retry', 'terminal']);
    const fetch = await box.service.fetch(box.repo);
    assert.equal(fetch.error.code, 'network');
  } finally { box.cleanup(); }
});

test('Git failures are classified with the next step', () => {
  const failure = (stderr, context) => classifyGitError({ code: 'EGIT', stderr }, context);
  assert.equal(failure("fatal: could not read Username for 'https://github.com': terminal prompts disabled", { operation: 'push', remote: 'origin' }).code, 'credentials');
  assert.equal(failure('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', { operation: 'push' }).code, 'credentials');
  assert.equal(failure('error: gpg failed to sign the data\nfatal: failed to write commit object').code, 'signing');
  assert.equal(failure(' ! [remote rejected] main -> main (protected branch hook declined)', { operation: 'push', destination: 'origin/main' }).message, 'origin/main refused the push (protected branch hook declined). Check the branch\'s protection rules or server hooks. Your commits are still here.');
  assert.equal(failure('Author identity unknown\n\n*** Please tell me who you are.').code, 'identity');
  assert.equal(classifyGitError({ code: 'ENOENT' }).code, 'unavailable');
  assert.equal(classifyGitError({ code: 'ETIMEDOUT', stderr: '' }, { operation: 'push' }).code, 'timeout');
  assert.equal(failure('fatal: something new', { operation: 'fetch' }).message, 'Git reported: something new');
  assert.equal(redact("fatal: unable to access 'https://user:ghp_secret@github.com/a/b.git/'"), "fatal: unable to access 'https://***@github.com/a/b.git/'");
  assert.doesNotMatch(failure("fatal: unable to access 'https://user:ghp_secret@github.com/a/b.git/': Could not resolve host").detail, /ghp_secret/);
  assert.deepEqual(progressOf('Writing objects:  45% (9/20)'), { phase: 'Writing objects', percent: 45 });
  assert.equal(progressOf('To github.com:a/b.git'), null);
});

test('push destinations that start release workflows are recognized', () => {
  const release = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8');
  assert.equal(workflowRunsOnPush(release, 'main'), true);
  assert.equal(workflowRunsOnPush(release, 'feature/login'), false);
  const patterns = 'name: Release\non:\n  push:\n    branches:\n      - "release/**"\n      - "!release/skip"\n  pull_request:\n';
  assert.equal(workflowRunsOnPush(patterns, 'release/1.0/hotfix'), true);
  assert.equal(workflowRunsOnPush(patterns, 'release/skip'), false);
  assert.equal(workflowRunsOnPush('on:\n  push:\n    tags: [v*]\n', 'main'), false, 'workflows without a branch filter are not called out');
  assert.equal(workflowRunsOnPush('on: push\n', 'main'), false);
});

test('Git IPC arguments reject option injection, escaping paths and unreviewed commits', () => {
  const review = { repository: '/repo', branch: 'main', head: null, index: 'a'.repeat(64) };
  validateArguments('gitCommit', ['/repo', message('Fix it', 'Body'), review]);
  validateArguments('gitStage', ['/repo', ['src/a b.js', 'README.md']]);
  validateArguments('gitPush', ['/repo', { remote: 'origin', branch: 'feature/x' }]);
  const rejects = (method, args) => assert.throws(() => validateArguments(method, args), /Invalid desktop API arguments/);
  rejects('gitSwitchBranch', ['/repo', '--orphan']);
  rejects('gitCreateBranch', ['/repo', 'a..b']);
  rejects('gitPublish', ['/repo', '-u']);
  rejects('gitStage', ['/repo', ['../outside']]);
  rejects('gitStage', ['/repo', ['/etc/passwd']]);
  rejects('gitStage', ['/repo', []]);
  rejects('gitStage', ['/repo', ['a', 'a']]);
  rejects('gitCommit', ['/repo', message('Two\nlines'), review]);
  rejects('gitCommit', ['/repo', message('   '), review]);
  rejects('gitCommit', ['/repo', message('Fix'), { ...review, index: 'nope' }]);
  rejects('gitCommit', ['/repo', { ...message('Fix'), amend: true }, review]);
  rejects('gitPush', ['/repo', { remote: 'origin', branch: 'main', force: true }]);
  rejects('gitCommitDetails', ['/repo', 'HEAD~1']);
  rejects('gitFileDiff', ['/repo', 'a.js', 'both', 3]);
  assert.equal(validRefName('feature/login'), true);
  assert.equal(validRefName('.hidden'), false);
  assert.equal(validRepositoryPath('a/./b'), false);
});

test('Git operations only act on the selected project', async () => {
  const box = sandbox();
  try {
    const backend = new DesktopBackend({ settingsService: { home: box.root } });
    backend.git = box.service;
    backend.workspace = box.repo;
    assert.equal((await backend.gitState(box.repo)).kind, 'repository');
    assert.throws(() => backend.gitStageAll(path.join(box.root, 'elsewhere')), /selected project changed/);
    await assert.rejects(backend.gitCommitMessage(box.repo), /Open a chat in this project/);
  } finally { box.cleanup(); }
});

test('generated commit messages are validated', () => {
  assert.deepEqual(parseCommitMessage('```json\n{"summary":"Add login","description":"- Email sign-in"}\n```'), { summary: 'Add login', description: '- Email sign-in' });
  assert.throws(() => parseCommitMessage('{"summary":""}'));
  assert.throws(() => parseCommitMessage('{"summary":"Line one\\nLine two"}'));
  assert.throws(() => parseCommitMessage(`{"summary":"${'x'.repeat(101)}"}`));
});


test('commit generation snapshots the selected provider, model and effort for both fields', async () => {
  const calls = [];
  let releaseContext;
  const context = new Promise(resolve => { releaseContext = resolve; });
  class MessageClient extends EventEmitter {
    exited = Promise.resolve();
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'initialize') return { agentCapabilities: { handwork: { backgroundTask: true } } };
      if (method === 'session/new') return { sessionId: 'commit-draft' };
      if (method === 'session/prompt') {
        this.emit('event', { params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ summary: 'Simplify commit editor', description: 'Use the selected model to draft both fields.' }) } } } });
        return { stopReason: 'end_turn' };
      }
      return {};
    }
    dispose() {}
  }
  const backend = new DesktopBackend({ settingsService: {}, clientFactory: () => new MessageClient() });
  backend.workspace = '/project';
  backend.session = { configOptions: ['provider', 'model', 'effort', 'fast_mode'].map((id, index) => ({ id, currentValue: ['selected-provider', 'selected-model', 'high', 'true'][index] })) };
  backend.git = { commitContext: () => context };
  const pending = backend.gitCommitMessage('/project');
  // Selecting another model while the diff loads must not change this request's route.
  backend.session.configOptions[1].currentValue = 'another-model';
  releaseContext({ context: 'staged diff', head: 'head', index: 'index' });
  assert.deepEqual(await pending, { summary: 'Simplify commit editor', description: 'Use the selected model to draft both fields.', head: 'head', index: 'index' });
  assert.deepEqual(calls.filter(call => call.method === 'session/set_config_option').map(call => [call.params.configId, call.params.value]), [
    ['provider', 'selected-provider'], ['model', 'selected-model'], ['effort', 'high'], ['fast_mode', 'true'],
  ]);
  const prompt = calls.findIndex(call => call.method === 'session/prompt');
  assert.ok(prompt > calls.findLastIndex(call => call.method === 'session/set_config_option'));
});
