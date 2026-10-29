import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { untrackedText } from './project-changes.mjs';

const MAX_ENTRIES = 1000;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const READ_TIMEOUT = 15000;
const NETWORK_TIMEOUT = 5 * 60000;
// Commit hooks may run a project's tests.
const COMMIT_TIMEOUT = 10 * 60000;
const ISOLATED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_PREFIX'];
const COMMIT_FORMAT = '%H%x00%h%x00%an%x00%ae%x00%at%x00%P%x00%s%x00%b%x1e';

/** Branch and remote names Handwork passes to Git. Never starts with "-", so it cannot become an option. */
export const validRefName = value => typeof value === 'string' && value.length > 0 && value.length <= 255 && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') && !value.endsWith('.') && !value.endsWith('.lock') && value !== '@' &&
  !/[\x00-\x20\x7f~^:?*[\\]/.test(value) && !value.includes('..') && !value.includes('@{') && !value.includes('//') && !value.split('/').some(part => part.startsWith('.'));
/** A path relative to the repository root, without "." or ".." segments. */
export const validRepositoryPath = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096 && !value.includes('\0') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.includes('\\') &&
  !value.split('/').some(part => part === '' || part === '.' || part === '..');
export const validObjectId = value => typeof value === 'string' && /^[0-9a-f]{7,64}$/.test(value);

/** Hides credentials embedded in remote URLs. */
export const redact = text => String(text ?? '').replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@');

export function runGit(cwd, args, { input, timeout = READ_TIMEOUT, env = {}, onProgress, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    // System credential helpers and SSH agents still work; Git must never wait on a prompt nobody can see.
    const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_MESSAGES: 'C', GIT_EDITOR: ':', GIT_MERGE_AUTOEDIT: 'no', ...env };
    for (const key of ISOLATED) delete environment[key];
    let child;
    try {
      child = spawn('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false', '-c', 'core.quotePath=false', '-C', cwd, ...args], { env: environment, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) { reject(error); return; }
    const output = [];
    let bytes = 0, stderr = '', pending = '', settled = false, overflow = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      finish(Object.assign(new Error('Git took too long to respond'), { code: 'ETIMEDOUT', stderr }));
    }, timeout);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBuffer) { overflow = true; child.kill('SIGTERM'); return; }
      output.push(chunk);
    });
    child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      if (stderr.length < 256 * 1024) stderr += text;
      if (!onProgress) return;
      const lines = (pending + text).split(/[\r\n]/);
      pending = lines.pop();
      for (const line of lines) if (line.trim()) onProgress(line);
    });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (overflow) { finish(Object.assign(new Error('Git output exceeded the preview limit'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })); return; }
      const stdout = Buffer.concat(output).toString('utf8');
      if (code === 0) finish(null, { stdout, stderr });
      else finish(Object.assign(new Error(stderr.trim().split('\n').at(-1) || `Git exited with status ${code}`), { code: 'EGIT', exitCode: code, stdout, stderr }));
    });
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

/** "Writing objects:  45% (9/20)" → { phase: 'Writing objects', percent: 45 } */
export function progressOf(line) {
  const match = /^(?:remote:\s*)?([A-Za-z][A-Za-z ]*?):\s+(\d{1,3})%/.exec(line.trim());
  return match ? { phase: match[1], percent: Math.min(100, Number(match[2])) } : null;
}

const failure = (code, title, message, actions = [], detail) => ({ code, title, message, actions, ...(detail ? { detail } : {}) });
const verbs = { commit: 'commit', push: 'push', publish: 'publish this branch', fetch: 'fetch', pull: 'pull', switch: 'switch branches', branch: 'create the branch', stage: 'stage these changes', unstage: 'unstage these changes' };

function overwrittenFiles(output) {
  const files = [];
  let listing = false;
  for (const line of output.split('\n')) {
    if (/would be overwritten by|untracked working tree files would be/.test(line)) { listing = true; continue; }
    if (listing && /^\t/.test(line)) files.push(line.trim());
    else if (listing && files.length) listing = false;
  }
  return files;
}

/** Turns Git's output into a reason and the next step a person can take. */
export function classifyGitError(error, context = {}) {
  const { operation = 'commit', remote = 'the remote', destination, upstream, ahead, behind } = context;
  const output = redact(`${error?.stdout ?? ''}\n${error?.stderr ?? ''}`).trim();
  const detail = output ? output.slice(-6000) : undefined;
  const destinationLabel = destination ?? upstream ?? remote;
  if (error?.code === 'ENOENT') return failure('unavailable', 'Git is unavailable', 'Install Git, then reopen Handwork to commit and push from here.');
  if (error?.code === 'ETIMEDOUT') return failure('timeout', 'Git took too long', `Git didn't finish within the time limit, so Handwork stopped waiting. Check ${operation === 'commit' ? 'your commit hooks' : 'your connection'} and retry, or run it in a terminal.`, ['retry', 'terminal'], detail);
  const lock = /Unable to create '([^']+\.lock)'|'([^']+\.lock)': File exists|index\.lock/.exec(output);
  if (lock) return failure('lock', 'Repository is busy', `Another Git process is using this repository. Wait for it to finish, then retry.${lock[1] || lock[2] ? ` If nothing else is running, a crashed process may have left ${path.basename(lock[1] || lock[2])} behind; remove it in a terminal.` : ''}`, ['retry', 'terminal'], detail);
  if (/Please tell me who you are|Author identity unknown|Committer identity unknown|unable to auto-detect email address|empty ident name/.test(output)) return identityFailure(detail);
  if (/gpg failed to sign|failed to sign the data|error: gpg|ssh-keygen|Couldn't load public key|signing failed|unsupported value for gpg\.format|failed to write commit object/i.test(output)) return failure('signing', 'Couldn’t sign the commit', 'Git is set up to sign commits, and signing failed. Unlock or fix your GPG or SSH signing key in a terminal, then retry. Your message is kept.', ['retry', 'terminal'], detail);
  if (/unmerged files|you need to resolve your current index first|not possible because you have unmerged|fix conflicts and then commit/i.test(output)) return failure('conflicts', 'Resolve merge conflicts first', 'Some files still have merge conflicts. Resolve them in your editor or a terminal and stage them, then try again.', ['terminal', 'refresh'], detail);
  if (/would be overwritten by (merge|checkout)|untracked working tree files would be (overwritten|removed)/.test(output)) {
    const files = overwrittenFiles(output);
    const list = files.length ? ` ${files.slice(0, 3).join(', ')}${files.length > 3 ? `, and ${files.length - 3} more` : ''}.` : '';
    return failure('dirty', 'Uncommitted changes are in the way', `${operation === 'pull' ? 'Pulling' : 'Switching'} would overwrite uncommitted changes to${list || ' some files.'} Commit them first, or stash them in a terminal. Handwork never discards or stashes them for you.`, ['terminal', 'refresh'], detail);
  }
  if (/Not possible to fast-forward|diverging branches|have diverged|refusing to merge unrelated histories/i.test(output)) {
    const counts = ahead || behind ? ` (${ahead ?? 0} local, ${behind ?? 0} incoming)` : '';
    return failure('diverged', 'Can’t fast-forward', `Your branch and ${upstream ?? 'its upstream'} have both changed${counts}. Handwork only pulls when it can fast-forward. Merge or rebase in a terminal, then push.`, ['terminal', 'fetch'], detail);
  }
  if (/\[remote rejected\]|pre-receive hook declined|protected branch|GH006|GH013/i.test(output)) {
    const reason = /\[remote rejected\][^(\n]*\(([^)\n]+)\)/.exec(output)?.[1];
    return failure('remote-rejected', 'The remote declined this push', `${destinationLabel} refused the push${reason ? ` (${reason})` : ''}. Check the branch's protection rules or server hooks. Your commits are still here.`, ['retry', 'terminal'], detail);
  }
  if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/.test(output)) return failure('rejected', 'Push rejected', `${destinationLabel} has commits you don't have yet. Pull them, then push again. Nothing on the remote was overwritten.`, ['pull', 'fetch'], detail);
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|returned error: 40[13]|Invalid username or password|Repository not found|access denied|denied to /i.test(output)) return failure('credentials', `Couldn’t sign in to ${remote}`, 'Handwork uses your system Git credentials and SSH keys. Sign in once from a terminal (for example, run the same git command there), then retry.', ['retry', 'terminal'], detail);
  if (/Could not resolve host|Could not resolve hostname|Connection refused|Connection timed out|Operation timed out|Network is unreachable|Failed to connect|Connection reset|Could not read from remote repository|does not appear to be a git repository|unable to access|SSL/i.test(output)) return failure('network', `Couldn’t reach ${remote}`, 'Check your connection and the remote address, then retry.', ['retry', 'terminal'], detail);
  if (context.hooks && operation === 'commit') return failure('hook', 'A commit hook stopped the commit', 'A pre-commit or commit-msg hook failed. Fix what it reported, stage the fixes, and commit again. Your message is kept.', ['retry', 'terminal'], detail);
  if (/nothing to commit|no changes added to commit|nothing added to commit/.test(output)) return failure('nothing-staged', 'Nothing to commit', 'Stage the changes you want to commit, then try again.', ['refresh'], detail);
  const reason = output.split('\n').map(line => line.replace(/^(fatal|error):\s*/, '').trim()).filter(Boolean).at(-1);
  return failure('unknown', `Couldn’t ${verbs[operation] ?? operation}`, reason ? `Git reported: ${reason}` : 'Git stopped without an explanation.', ['retry', 'terminal'], detail);
}

const identityFailure = detail => failure('identity', 'Set your Git identity', 'Git needs your name and email before it can commit. Run these in a terminal with your details, then commit again:', ['terminal', 'retry'],
  `git config --global user.name "Your Name"\ngit config --global user.email "you@example.com"${detail ? `\n\n${detail}` : ''}`);

function numstats(output) {
  return new Map(output.split('\0').filter(Boolean).map(row => {
    const first = row.indexOf('\t'), second = row.indexOf('\t', first + 1);
    const added = row.slice(0, first), removed = row.slice(first + 1, second);
    return [row.slice(second + 1), { added: Number(added) || 0, removed: Number(removed) || 0, binary: added === '-' || removed === '-' }];
  }));
}

function parseConfig(output) {
  const values = new Map();
  for (const record of output.split('\0')) {
    const newline = record.indexOf('\n');
    if (newline < 1) continue;
    const key = record.slice(0, newline), value = record.slice(newline + 1);
    // Section and variable names are case-insensitive; subsections (branch and remote names) are not.
    const first = key.indexOf('.'), last = key.lastIndexOf('.');
    const normalized = first === last ? key.toLowerCase() : `${key.slice(0, first).toLowerCase()}.${key.slice(first + 1, last)}.${key.slice(last + 1).toLowerCase()}`;
    if (!values.has(normalized)) values.set(normalized, []);
    values.get(normalized).push(value);
  }
  return { get: key => values.get(key)?.at(-1), keys: () => [...values.keys()] };
}

function parseCommits(output) {
  return output.split('\x1e').map(record => record.replace(/^\n/, '')).filter(Boolean).map(record => {
    const [oid, short, author, email, time, parents, subject, ...body] = record.split('\0');
    return { oid, short, author, email, date: Number(time) * 1000, parents: parents ? parents.split(' ') : [], subject, body: body.join('\0').trim() };
  });
}

const globPattern = pattern => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*')}$`);
const indentOf = line => line.length - line.trimStart().length;
const unquote = value => value.replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '');

/** Whether a workflow names `branch` in its `on.push.branches` filter. Workflows that run on every push are not called out. */
export function workflowRunsOnPush(source, branch) {
  const lines = String(source).replace(/\r/g, '').split('\n').filter(line => line.trim() && !line.trimStart().startsWith('#'));
  const children = (list, start) => {
    const result = [];
    for (let index = start + 1; index < list.length && indentOf(list[index]) > indentOf(list[start]); index++) result.push(list[index]);
    return result;
  };
  const on = lines.findIndex(line => /^(on|'on'|"on"):\s*$/.test(line));
  if (on === -1) return false;
  const trigger = children(lines, on);
  const push = trigger.findIndex(line => indentOf(line) === indentOf(trigger[0]) && /^\s*push:\s*$/.test(line));
  if (push === -1) return false;
  const settings = children(trigger, push);
  const filter = settings.findIndex(line => indentOf(line) === indentOf(settings[0]) && /^\s*branches:/.test(line));
  if (filter === -1) return false;
  const inline = /^\s*branches:\s*(.+)$/.exec(settings[filter])?.[1];
  const patterns = (inline ? inline.replace(/^\[|\]$/g, '').split(',') : children(settings, filter).map(line => /^\s*-\s*(.+)$/.exec(line)?.[1] ?? '')).map(unquote).filter(Boolean);
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) { if (globPattern(pattern.slice(1)).test(branch)) matched = false; }
    else if (globPattern(pattern).test(branch)) matched = true;
  }
  return matched;
}

async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function executable(file) { try { await access(file, constants.X_OK); return (await stat(file)).isFile(); } catch { return false; } }

export class GitService {
  locks = new Map();
  busy = new Map();
  known = new Map();
  workflowCache = new Map();
  admission = Promise.resolve();

  constructor({ env = {}, emit = () => {}, openTerminal = null } = {}) {
    this.env = env;
    this.emit = emit;
    this.openTerminalHost = openTerminal;
  }

  git(cwd, args, options = {}) { return runGit(cwd, args, { ...options, env: { ...this.env, ...options.env } }); }
  async text(cwd, args, options) { return (await this.git(cwd, args, options)).stdout; }
  async optional(cwd, args) { try { return (await this.git(cwd, args)).stdout.trim(); } catch (error) { if (error.code === 'ENOENT') throw error; return null; } }

  /** The repository that contains `workspace`, or null when it is not in one. */
  async resolve(workspace) {
    if (!workspace) return null;
    const project = await realpath(workspace);
    let top;
    try { top = (await this.text(project, ['rev-parse', '--show-toplevel'])).trim(); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Git is unavailable. Install Git to review and commit changes.');
      if (/not a git repository/i.test(String(error.stderr))) return null;
      throw new Error('Could not read this Git repository. Check its availability and Git permissions.');
    }
    const repository = await realpath(top);
    return { project, repository, scope: path.relative(repository, project).split(path.sep).join('/') };
  }

  async state(workspace) {
    const resolved = await this.resolve(workspace);
    if (!resolved) return { workspace, kind: workspace ? 'not-repository' : 'no-project', checkedAt: Date.now() };
    return this.readState(workspace, resolved);
  }

  async readState(workspace, { project, repository, scope }) {
    const diffArgs = ['--no-ext-diff', '--no-textconv', '--no-renames', '-z'];
    const [status, cached, working, raw, configText, gitPaths, identity] = await Promise.all([
      this.text(repository, ['-c', 'status.renames=false', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      this.text(repository, ['diff', '--cached', '--numstat', ...diffArgs]),
      this.text(repository, ['diff', '--numstat', ...diffArgs]),
      this.text(repository, ['diff', '--cached', '--raw', '--no-abbrev', ...diffArgs]),
      this.optional(repository, ['config', '-z', '--get-regexp', '^(remote|branch|push)\\.']),
      this.text(repository, ['rev-parse', '--git-path', 'FETCH_HEAD', '--git-path', 'MERGE_HEAD', '--git-path', 'rebase-merge', '--git-path', 'rebase-apply', '--git-path', 'CHERRY_PICK_HEAD', '--git-path', 'REVERT_HEAD']),
      this.optional(repository, ['var', 'GIT_COMMITTER_IDENT']),
    ]);
    const config = parseConfig(configText ?? '');
    const head = { branch: null, oid: null, detached: false, unborn: false };
    let upstreamRef = null, ab = null;
    const rows = status.split('\0');
    const staged = [], unstaged = [], conflicts = [];
    const index = numstats(cached), worktree = numstats(working);
    const inProject = file => !scope || file === scope || file.startsWith(scope + '/');
    let total = 0, budget = 4 * 1024 * 1024;
    for (let position = 0; position < rows.length; position++) {
      const row = rows[position];
      if (!row) continue;
      if (row.startsWith('# ')) {
        const [key, ...rest] = row.slice(2).split(' ');
        const value = rest.join(' ');
        if (key === 'branch.oid') { head.unborn = value === '(initial)'; head.oid = head.unborn ? null : value; }
        else if (key === 'branch.head') { head.detached = value === '(detached)'; head.branch = head.detached ? null : value; }
        else if (key === 'branch.upstream') upstreamRef = value;
        else if (key === 'branch.ab') { const match = /^\+(\d+) -(\d+)$/.exec(value); if (match) ab = { ahead: Number(match[1]), behind: Number(match[2]) }; }
        continue;
      }
      if (++total > MAX_ENTRIES) continue;
      const type = row[0];
      if (type === '?') {
        const file = row.slice(2);
        const entry = { path: file, status: '?', untracked: true, added: 0, removed: 0, binary: false, complete: false, inProject: inProject(file) };
        try {
          const content = await untrackedText(repository, path.join(repository, file), budget);
          budget -= content.bytes;
          entry.binary = !!content.binary;
          entry.complete = content.text !== undefined || !!content.binary;
          if (content.text) entry.added = content.text.split('\n').length - (content.text.endsWith('\n') ? 1 : 0);
        } catch {}
        unstaged.push(entry);
      } else if (type === 'u') {
        const fields = row.split(' ');
        const file = fields.slice(10).join(' ');
        conflicts.push({ path: file, status: fields[1], added: 0, removed: 0, binary: false, complete: false, conflict: true, inProject: inProject(file) });
      } else if (type === '1' || type === '2') {
        const fields = row.split(' ');
        const file = fields.slice(type === '1' ? 8 : 9).join(' ');
        if (type === '2') position++;
        const [x, y] = fields[1];
        if (x !== '.') { const counts = index.get(file); staged.push({ path: file, status: x, added: counts?.added ?? 0, removed: counts?.removed ?? 0, binary: !!counts?.binary, complete: true, inProject: inProject(file) }); }
        if (y !== '.') { const counts = worktree.get(file); unstaged.push({ path: file, status: y, added: counts?.added ?? 0, removed: counts?.removed ?? 0, binary: !!counts?.binary, complete: true, inProject: inProject(file) }); }
      }
    }
    const stagedPaths = new Set(staged.map(entry => entry.path));
    const unstagedPaths = new Set(unstaged.map(entry => entry.path));
    for (const entry of [...staged, ...unstaged]) entry.partial = stagedPaths.has(entry.path) && unstagedPaths.has(entry.path);
    this.known.set(repository, { staged: stagedPaths, unstaged: new Map(unstaged.map(entry => [entry.path, entry])), conflicts: new Set(conflicts.map(entry => entry.path)) });

    const remotes = config.keys().filter(key => /^remote\..+\.url$/.test(key)).map(key => ({ name: key.slice(7, -4), url: redact(config.get(key)) }));
    const remoteOf = ref => remotes.map(remote => remote.name).filter(name => ref.startsWith(`refs/remotes/${name}/`)).sort((a, b) => b.length - a.length)[0];
    let upstream = null;
    if (upstreamRef && head.branch) {
      const remote = config.get(`branch.${head.branch}.remote`) ?? upstreamRef.split('/')[0];
      const merge = config.get(`branch.${head.branch}.merge`) ?? '';
      upstream = { name: upstreamRef, remote, branch: merge.replace(/^refs\/heads\//, '') || upstreamRef.slice(remote.length + 1), gone: !ab };
    }
    // Git's own answer for where `git push` sends this branch; it refuses ambiguous destinations.
    let push = null, publish = null;
    if (head.branch && !head.unborn) {
      const pushRef = await this.optional(repository, ['rev-parse', '--symbolic-full-name', '@{push}']);
      const remote = pushRef && remoteOf(pushRef);
      if (remote) {
        const exists = !!(await this.optional(repository, ['rev-parse', '--verify', '--quiet', pushRef]));
        const outgoing = Number(await this.optional(repository, exists ? ['rev-list', '--count', `${pushRef}..HEAD`] : ['rev-list', '--count', 'HEAD', '--not', `--remotes=${remote}`])) || 0;
        push = { remote, branch: pushRef.slice(`refs/remotes/${remote}/`.length), ref: pushRef, exists, outgoing };
      }
    }
    if (head.branch && !push && remotes.length) {
      const outgoing = head.unborn ? 0 : Number(await this.optional(repository, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])) || 0;
      publish = { reason: upstream ? 'mismatch' : 'no-upstream', branch: head.branch, outgoing, defaultRemote: config.get(`branch.${head.branch}.pushremote`) ?? config.get('remote.pushdefault') ?? (remotes.some(remote => remote.name === 'origin') ? 'origin' : remotes[0].name) };
    }
    const [fetchHead, mergeHead, rebaseMerge, rebaseApply, cherryPick, revert] = gitPaths.split('\n').map(line => path.resolve(repository, line.trim()));
    const fetched = await stat(fetchHead).catch(() => null);
    const operation = await exists(rebaseMerge) || await exists(rebaseApply) ? 'rebase' : await exists(mergeHead) ? 'merge' : await exists(cherryPick) ? 'cherry-pick' : await exists(revert) ? 'revert' : null;
    const identityMatch = identity && /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(identity);
    const workflows = push || publish ? await this.pushWorkflows(repository, push?.branch ?? head.branch) : [];
    return {
      workspace, kind: 'repository', project, repository, name: path.basename(repository), scope,
      head, upstream, ahead: ab?.ahead ?? null, behind: ab?.behind ?? null, push, publish, remotes,
      fetchedAt: fetched ? Math.round(fetched.mtimeMs) : null, operation,
      identity: identityMatch ? { name: identityMatch[1], email: identityMatch[2] } : null,
      staged, unstaged, conflicts, totalFiles: total, truncated: total > MAX_ENTRIES,
      // What `git commit` would record: the staged difference from this HEAD.
      index: createHash('sha256').update(`${head.oid ?? 'unborn'}\0${raw}`).digest('hex'),
      workflows, busy: this.busy.get(repository) ?? null, checkedAt: Date.now(),
    };
  }

  /** Names of GitHub workflows that run when `branch` is pushed. */
  async pushWorkflows(repository, branch) {
    const directory = path.join(repository, '.github', 'workflows');
    const key = `${repository}\0${branch}`;
    const cached = this.workflowCache.get(key);
    if (cached && Date.now() - cached.at < 30000) return cached.names;
    const names = [];
    try {
      for (const file of (await readdir(directory)).filter(name => /\.ya?ml$/i.test(name)).slice(0, 50)) {
        const full = path.join(directory, file);
        if (!(await realpath(full)).startsWith(repository + path.sep) || (await stat(full)).size > 128 * 1024) continue;
        const source = await readFile(full, 'utf8');
        if (workflowRunsOnPush(source, branch)) names.push(unquote(/^name:\s*(.+)$/m.exec(source)?.[1] ?? '') || file);
      }
    } catch {}
    this.workflowCache.set(key, { names, at: Date.now() });
    return names;
  }

  /**
   * Serializes mutations per repository, across every chat, and returns the refreshed state.
   * Failures resolve with a classified error so the renderer can offer the next step.
   */
  async mutate(workspace, operation, action, context = () => ({})) {
    // Join the repository's queue in arrival order, even though finding the repository is asynchronous.
    const admitted = this.admission.then(() => this.resolve(workspace));
    this.admission = admitted.catch(() => {});
    let resolved;
    try { resolved = await admitted; }
    catch (error) { return { ok: false, error: failure('unavailable', 'Git is unavailable', error.message) }; }
    if (!resolved) return { ok: false, error: failure('not-repository', 'Not a Git repository', 'This project is not inside a Git repository.') };
    const { repository } = resolved;
    const previous = this.locks.get(repository) ?? Promise.resolve();
    let release;
    const tail = previous.then(() => new Promise(resolve => { release = resolve; }));
    this.locks.set(repository, tail);
    await previous;
    this.busy.set(repository, operation);
    this.emit({ method: 'desktop/git', params: { repository, operation, phase: 'start' } });
    let result;
    try {
      const before = await this.readState(workspace, resolved);
      result = await action(resolved, before);
    } catch (error) {
      const hooks = operation === 'commit' && await this.hasCommitHooks(repository);
      result = { ok: false, error: classifyGitError(error, { operation, hooks, ...context(error) }) };
    } finally {
      this.busy.delete(repository);
    }
    try { result.state = await this.readState(workspace, resolved); } catch {}
    release();
    if (this.locks.get(repository) === tail) this.locks.delete(repository);
    this.emit({ method: 'desktop/git', params: { repository, operation, phase: 'end', ok: result.ok } });
    return result;
  }

  async hasCommitHooks(repository) {
    const directory = await this.optional(repository, ['rev-parse', '--git-path', 'hooks']);
    if (!directory) return false;
    for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg']) if (await executable(path.resolve(repository, directory, hook))) return true;
    return false;
  }

  progress(repository, operation) {
    let last = 0;
    return line => {
      const value = progressOf(line);
      if (!value || (Date.now() - last < 100 && value.percent < 100)) return;
      last = Date.now();
      this.emit({ method: 'desktop/git', params: { repository, operation, phase: 'progress', step: value.phase, percent: value.percent } });
    };
  }

  stage(workspace, paths) {
    return this.mutate(workspace, 'stage', async ({ repository }, state) => {
      const known = new Set([...state.unstaged.map(entry => entry.path), ...state.conflicts.map(entry => entry.path)]);
      const missing = paths.filter(file => !known.has(file));
      if (missing.length) return { ok: false, error: failure('changed', 'Changes were updated', `${missing[0]} has no unstaged changes anymore. Review the refreshed list.`, ['refresh']) };
      for (const file of paths.filter(item => state.conflicts.some(entry => entry.path === item))) {
        const text = await readFile(path.join(repository, file), 'utf8').catch(() => '');
        if (/^(<{7}|>{7})( |$)/m.test(text)) return { ok: false, error: failure('conflicts', 'Conflict markers remain', `${file} still contains conflict markers. Finish resolving it in your editor, then stage it.`, ['terminal', 'refresh']) };
      }
      await this.git(repository, ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0') });
      return { ok: true };
    });
  }

  stageAll(workspace) {
    return this.mutate(workspace, 'stage', async ({ repository }, state) => {
      // Staging a conflicted file marks it resolved, so Stage all leaves conflicts alone.
      if (state.conflicts.length || state.truncated) {
        const files = state.unstaged.map(entry => entry.path);
        if (files.length) await this.git(repository, ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: files.join('\0') });
      } else await this.git(repository, ['add', '--all']);
      return { ok: true };
    });
  }

  unstage(workspace, paths) {
    return this.mutate(workspace, 'unstage', async ({ repository }, state) => {
      const missing = paths.filter(file => !state.staged.some(entry => entry.path === file));
      if (missing.length) return { ok: false, error: failure('changed', 'Changes were updated', `${missing[0]} has no staged changes anymore. Review the refreshed list.`, ['refresh']) };
      await this.git(repository, ['reset', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0') });
      return { ok: true };
    });
  }

  unstageAll(workspace) {
    return this.mutate(workspace, 'unstage', async ({ repository }, state) => {
      if (state.conflicts.length) return { ok: false, error: failure('conflicts', 'Resolve merge conflicts first', 'Unstaging everything during a merge would lose the resolution state. Unstage files one at a time, or finish the merge in a terminal.', ['terminal']) };
      await this.git(repository, ['reset', '--quiet']);
      return { ok: true };
    });
  }

  commit(workspace, message, expected) {
    return this.mutate(workspace, 'commit', async ({ repository }, state) => {
      // The commit must record what the person reviewed.
      if (state.repository !== expected.repository || state.head.branch !== expected.branch || state.head.oid !== expected.head || state.index !== expected.index) {
        return { ok: false, changed: true, error: failure('changed', 'Staged changes changed', state.head.branch !== expected.branch || state.head.oid !== expected.head ? `The branch moved to ${state.head.branch ?? 'a detached HEAD'} since you reviewed it. Check the refreshed preview, then commit again.` : 'The staged files changed since you reviewed them. Check the refreshed preview, then commit again.', []) };
      }
      if (state.operation === 'rebase') return { ok: false, error: failure('operation', 'A rebase is in progress', 'Finish or abort the rebase in a terminal before committing here.', ['terminal']) };
      if (state.conflicts.length) return { ok: false, error: failure('conflicts', 'Resolve merge conflicts first', `${state.conflicts.length === 1 ? '1 file has' : `${state.conflicts.length} files have`} merge conflicts. Resolve and stage ${state.conflicts.length === 1 ? 'it' : 'them'}, then commit.`, ['terminal', 'refresh']) };
      if (state.head.detached) return { ok: false, error: failure('detached', 'No branch is checked out', 'You are on a detached HEAD, so a new commit would not belong to any branch. Create a branch here first; your staged changes come with you.', ['branch']) };
      if (!state.staged.length && state.operation !== 'merge') return { ok: false, error: failure('nothing-staged', 'Nothing staged', 'Stage the changes you want to commit, then try again.', []) };
      if (!state.identity) return { ok: false, error: identityFailure() };
      const text = message.description.trim() ? `${message.summary.trim()}\n\n${message.description.trim()}\n` : `${message.summary.trim()}\n`;
      try {
        await this.git(repository, ['commit', '--file=-'], { input: text, timeout: COMMIT_TIMEOUT });
      } catch (error) {
        // A failing post-commit hook does not undo the commit.
        const after = await this.optional(repository, ['rev-parse', '--verify', '--quiet', 'HEAD']);
        if (!after || after === state.head.oid) throw error;
      }
      const [oid, short] = (await this.text(repository, ['log', '-1', '--format=%H %h'])).trim().split(' ');
      return { ok: true, commit: { oid, short, summary: message.summary.trim() } };
    });
  }

  push(workspace, expected) {
    let target;
    return this.mutate(workspace, 'push', async ({ repository }, state) => {
      if (state.head.detached) return { ok: false, error: failure('detached', 'No branch is checked out', 'Create or switch to a branch before pushing.', ['branch']) };
      if (!state.push) return { ok: false, error: failure('no-upstream', 'Publish this branch first', `${state.head.branch} has no destination to push to yet. Publish it to choose a remote.`, ['publish']) };
      if (state.push.remote !== expected.remote || state.push.branch !== expected.branch) return { ok: false, changed: true, error: failure('changed', 'Push destination changed', `This branch now pushes to ${state.push.remote}/${state.push.branch}. Check the destination, then push again.`, []) };
      target = state;
      await this.git(repository, ['push', '--progress', '--porcelain', state.push.remote, `refs/heads/${state.head.branch}:refs/heads/${state.push.branch}`], { timeout: NETWORK_TIMEOUT, onProgress: this.progress(repository, 'push') });
      return { ok: true, destination: `${state.push.remote}/${state.push.branch}` };
    }, () => ({ remote: target?.push?.remote, destination: target?.push ? `${target.push.remote}/${target.push.branch}` : undefined }));
  }

  publish(workspace, remote) {
    let branch;
    return this.mutate(workspace, 'publish', async ({ repository }, state) => {
      if (state.head.detached || !state.head.branch) return { ok: false, error: failure('detached', 'No branch is checked out', 'Create or switch to a branch before publishing.', ['branch']) };
      if (state.head.unborn) return { ok: false, error: failure('unborn', 'Make a first commit', 'This branch has no commits yet. Commit something, then publish it.', []) };
      if (!state.remotes.some(item => item.name === remote)) return { ok: false, error: failure('no-remote', 'Remote not found', `This repository has no remote named ${remote}. Add one in a terminal, for example: git remote add origin <url>.`, ['terminal', 'refresh']) };
      branch = state.head.branch;
      await this.git(repository, ['push', '--progress', '--porcelain', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`], { timeout: NETWORK_TIMEOUT, onProgress: this.progress(repository, 'publish') });
      return { ok: true, destination: `${remote}/${branch}` };
    }, () => ({ remote, destination: branch ? `${remote}/${branch}` : undefined }));
  }

  fetch(workspace) {
    let remote;
    return this.mutate(workspace, 'fetch', async ({ repository }, state) => {
      if (!state.remotes.length) return { ok: false, error: failure('no-remote', 'No remote configured', 'Add a remote in a terminal, for example: git remote add origin <url>.', ['terminal']) };
      const names = [...new Set([state.upstream?.remote, state.push?.remote].filter(name => state.remotes.some(item => item.name === name)))];
      remote = names.length === 1 ? names[0] : undefined;
      await this.git(repository, ['fetch', '--progress', ...(names.length ? ['--multiple', ...names] : ['--all'])], { timeout: NETWORK_TIMEOUT, onProgress: this.progress(repository, 'fetch') });
      return { ok: true };
    }, () => ({ remote }));
  }

  pull(workspace) {
    let target;
    return this.mutate(workspace, 'pull', async ({ repository }, state) => {
      if (state.head.detached) return { ok: false, error: failure('detached', 'No branch is checked out', 'Switch to a branch before pulling.', ['branch']) };
      if (!state.upstream) return { ok: false, error: failure('no-upstream', 'Nothing to pull from', `${state.head.branch} doesn't track a remote branch yet. Publish it first.`, state.publish ? ['publish'] : []) };
      if (state.upstream.gone) return { ok: false, error: failure('gone', 'Upstream branch is gone', `${state.upstream.name} no longer exists on the remote. Publish this branch again or switch branches.`, ['publish']) };
      if (state.operation) return { ok: false, error: failure('operation', `A ${state.operation} is in progress`, `Finish or abort the ${state.operation} in a terminal before pulling.`, ['terminal']) };
      target = state;
      try {
        await this.git(repository, ['pull', '--ff-only', '--no-rebase', '--progress', state.upstream.remote, `refs/heads/${state.upstream.branch}`], { timeout: NETWORK_TIMEOUT, onProgress: this.progress(repository, 'pull') });
      } catch (error) {
        // Report the divergence the fetch just revealed.
        const counts = await this.optional(repository, ['rev-list', '--left-right', '--count', `HEAD...${state.upstream.name}`]);
        if (counts) { const [ahead, behind] = counts.split(/\s+/).map(Number); target = { ...state, ahead, behind }; }
        throw error;
      }
      return { ok: true };
    }, () => ({ remote: target?.upstream?.remote, upstream: target?.upstream?.name, ahead: target?.ahead, behind: target?.behind }));
  }

  async branches(workspace) {
    const resolved = await this.resolve(workspace);
    if (!resolved) return { workspace, current: null, branches: [] };
    const output = await this.text(resolved.repository, ['for-each-ref', '--sort=-committerdate', '--count=500', '--format=%(refname)%00%(objectname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(contents:subject)%00%(HEAD)', 'refs/heads']);
    const branches = output.split('\n').filter(Boolean).map(line => {
      const [ref, oid, upstream, track, time, subject, current] = line.split('\0');
      return { name: ref.replace(/^refs\/heads\//, ''), oid, upstream: upstream || null, track: track || '', date: Number(time) * 1000, subject, current: current === '*' };
    });
    const head = await this.optional(resolved.repository, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return { workspace, current: head, branches };
  }

  switchBranch(workspace, name) {
    return this.mutate(workspace, 'switch', async ({ repository }, state) => {
      if (state.head.branch === name) return { ok: true };
      if (!(await this.optional(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]))) return { ok: false, error: failure('missing-branch', 'Branch not found', `There is no local branch named ${name}. Refresh the branch list.`, ['refresh']) };
      if (state.operation) return { ok: false, error: failure('operation', `A ${state.operation} is in progress`, `Finish or abort the ${state.operation} before switching branches.`, ['terminal']) };
      // No --force, --merge, or autostash: Git refuses rather than touching uncommitted work.
      await this.git(repository, ['switch', '--no-guess', name], { timeout: 60000 });
      return { ok: true };
    });
  }

  createBranch(workspace, name) {
    return this.mutate(workspace, 'branch', async ({ repository }, state) => {
      try { await this.git(repository, ['check-ref-format', '--branch', name]); }
      catch { return { ok: false, error: failure('invalid-branch', 'Invalid branch name', `${name} isn't a valid branch name. Avoid spaces and characters like ~ ^ : ? * [ and \\.`, []) }; }
      if (await this.optional(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) return { ok: false, error: failure('branch-exists', 'Branch already exists', `A branch named ${name} already exists. Switch to it, or choose another name.`, []) };
      if (state.operation) return { ok: false, error: failure('operation', `A ${state.operation} is in progress`, `Finish or abort the ${state.operation} before creating a branch.`, ['terminal']) };
      await this.git(repository, ['switch', '--no-track', '--create', name], { timeout: 60000 });
      return { ok: true, branch: name };
    });
  }

  async log(workspace, limit = 50) {
    const resolved = await this.resolve(workspace);
    if (!resolved) return { workspace, commits: [], incoming: [] };
    const { repository } = resolved;
    const head = await this.optional(repository, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (!head) return { workspace, commits: [], incoming: [] };
    const [output, pushRef, upstreamRef, remotes] = await Promise.all([
      this.text(repository, ['log', `--max-count=${limit}`, `--format=${COMMIT_FORMAT}`, 'HEAD']),
      this.optional(repository, ['rev-parse', '--symbolic-full-name', '@{push}']),
      this.optional(repository, ['rev-parse', '--symbolic-full-name', '@{upstream}']),
      this.optional(repository, ['remote']),
    ]);
    const pushExists = pushRef && await this.optional(repository, ['rev-parse', '--verify', '--quiet', pushRef]);
    // With no remote at all, nothing is awaiting a push.
    const localOutput = !remotes ? '' : await this.optional(repository, ['rev-list', '--max-count=1000', ...(pushExists ? [`${pushRef}..HEAD`] : ['HEAD', '--not', '--remotes'])]);
    const local = new Set((localOutput ?? '').split('\n').filter(Boolean));
    const upstreamExists = upstreamRef && await this.optional(repository, ['rev-parse', '--verify', '--quiet', upstreamRef]);
    const incoming = upstreamExists ? parseCommits(await this.text(repository, ['log', '--max-count=50', `--format=${COMMIT_FORMAT}`, `HEAD..${upstreamRef}`])) : [];
    return { workspace, commits: parseCommits(output).map(commit => ({ ...commit, local: local.has(commit.oid) })), incoming, upstream: upstreamRef?.replace(/^refs\/remotes\//, '') ?? null };
  }

  async commitFiles(repository, oid) {
    const full = await this.optional(repository, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${oid}^{commit}`]);
    if (!full) throw new Error('This commit is no longer available. Refresh the history.');
    const showArgs = ['show', '--format=', '--no-renames', '--diff-merges=first-parent', '-z', full];
    const [names, counts] = await Promise.all([this.text(repository, [...showArgs.slice(0, -1), '--name-status', full]), this.text(repository, [...showArgs.slice(0, -1), '--numstat', full])]);
    const stats = numstats(counts);
    const parts = names.split('\0').filter(Boolean), files = [];
    for (let index = 0; index + 1 < parts.length && files.length < MAX_ENTRIES; index += 2) {
      const counts = stats.get(parts[index + 1]);
      files.push({ path: parts[index + 1], status: parts[index][0], added: counts?.added ?? 0, removed: counts?.removed ?? 0, binary: !!counts?.binary, complete: true });
    }
    return { full, files };
  }

  async commitDetails(workspace, oid) {
    const resolved = await this.resolve(workspace);
    if (!resolved) throw new Error('This project is not a Git repository.');
    const { full, files } = await this.commitFiles(resolved.repository, oid);
    const [commit] = parseCommits(await this.text(resolved.repository, ['show', '-s', `--format=${COMMIT_FORMAT}`, full]));
    return { workspace, ...commit, files };
  }

  async commitFileDiff(workspace, oid, file, context = 3) {
    const resolved = await this.resolve(workspace);
    if (!resolved) throw new Error('This project is not a Git repository.');
    const { full, files } = await this.commitFiles(resolved.repository, oid);
    if (!files.some(item => item.path === file)) throw new Error('This file is not part of the commit.');
    return { workspace, path: file, oid: full, context, sections: [await this.patchSection(resolved.repository, 'Commit', ['show', '--format=', '--diff-merges=first-parent', ...this.patchArgs(context), full, '--', file])] };
  }

  patchArgs(context) { return ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--submodule=short', `--unified=${Math.max(0, Math.min(1000000, Math.trunc(Number(context) || 0)))}`]; }

  async patchSection(repository, label, args) {
    try {
      const { stdout } = await this.git(repository, args, { maxBuffer: MAX_DIFF_BYTES });
      return { label, patch: stdout, note: stdout ? undefined : 'No diff is available. The file may have changed since the last refresh.' };
    } catch (error) {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { label, note: 'This diff exceeds the 2 MB preview limit.' };
      throw new Error('Could not read this diff. Refresh the changes.');
    }
  }

  /** The staged or unstaged diff of one file; a partially staged file has both. */
  async fileDiff(workspace, file, area, context = 3) {
    const resolved = await this.resolve(workspace);
    const known = resolved && this.known.get(resolved.repository);
    if (!known) throw new Error('Refresh the changes to load this diff.');
    const { repository } = resolved;
    if (area === 'staged') {
      if (!known.staged.has(file)) throw new Error('This file has no staged changes anymore. Refresh the changes.');
      return { workspace, path: file, area, context, sections: [await this.patchSection(repository, 'Staged', ['diff', '--cached', ...this.patchArgs(context), '--', file])] };
    }
    const entry = known.unstaged.get(file);
    if (!entry && known.conflicts.has(file)) return { workspace, path: file, area, context, sections: [await this.patchSection(repository, 'Conflict', ['diff', ...this.patchArgs(context), '--', file])] };
    if (!entry) throw new Error('This file has no unstaged changes anymore. Refresh the changes.');
    if (entry.untracked) {
      try {
        const content = await untrackedText(repository, path.join(repository, file));
        return { workspace, path: file, area, context, sections: [{ label: 'Untracked', text: content.text, note: content.note }] };
      } catch { throw new Error('This file changed or became unavailable. Refresh the changes.'); }
    }
    return { workspace, path: file, area, context, sections: [await this.patchSection(repository, 'Unstaged', ['diff', ...this.patchArgs(context), '--', file])] };
  }

  /** Untrusted evidence for a commit message: the staged diff and recent subjects for style. */
  async commitContext(workspace) {
    const resolved = await this.resolve(workspace);
    if (!resolved) throw new Error('This project is not a Git repository.');
    const state = await this.readState(workspace, resolved);
    if (!state.staged.length) throw new Error('Stage changes before writing a commit message.');
    const { repository } = resolved;
    const [summary, recent] = await Promise.all([
      this.text(repository, ['diff', '--cached', '--stat=120', '--no-color', '--no-ext-diff']),
      state.head.unborn ? '' : this.optional(repository, ['log', '-12', '--format=%s']),
    ]);
    let patch;
    try { patch = (await this.git(repository, ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=2'], { maxBuffer: 4 * 1024 * 1024 })).stdout; }
    catch { patch = ''; }
    const limit = 48000;
    const context = JSON.stringify({ branch: state.head.branch, files: summary.slice(0, 8000), recentCommitSubjects: (recent ?? '').slice(0, 2000), stagedDiff: patch.length > limit ? `${patch.slice(0, limit)}\n[diff truncated]` : patch });
    return { context, head: state.head.oid, index: state.index, files: state.staged.length };
  }

  async openTerminal(workspace) {
    const resolved = await this.resolve(workspace);
    if (!this.openTerminalHost) throw new Error('Opening a terminal is not available in this build.');
    await this.openTerminalHost(resolved?.repository ?? await realpath(workspace));
  }
}
