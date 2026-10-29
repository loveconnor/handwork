import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const REQUEST_TIMEOUT_MS = 20_000;
const OUTCOMES = new Set(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']);

/**
 * Codex rate-limit resets: banked rewards that clear the usage windows once.
 * The Handwork engine reads usage over HTTP but cannot see or spend these, so
 * they come from the Codex app-server, as the native app did. Each call starts
 * a short-lived `codex app-server`, signed in as whoever is signed in to Codex,
 * and calls are serialized so two never race for the same credit.
 */
export class CodexResets {
  constructor({ spawn = spawnProcess, env = process.env, candidates = codexCandidates(env), timeout = REQUEST_TIMEOUT_MS } = {}) {
    this.spawn = spawn; this.env = env; this.candidates = candidates; this.timeout = timeout;
    this.queue = Promise.resolve();
    this.binary = undefined;
  }

  /** Available resets and the account they belong to, or null when Codex is not installed or signed in. */
  read() {
    return this.serial(async () => {
      const binary = await this.findBinary();
      if (!binary) return null;
      const [account, limits] = await this.request(binary, ['account/read', 'account/rateLimits/read']);
      const credits = parseCredits(limits?.rateLimitResetCredits);
      if (!credits) return null;
      return { email: typeof account?.account?.email === 'string' ? account.account.email : null, ...credits };
    });
  }

  /** Spend one reset. Codex picks the credit when none is named. */
  use(creditId) {
    return this.serial(async () => {
      const binary = await this.findBinary();
      if (!binary) throw new Error('Codex is not installed. Install the Codex CLI or the ChatGPT app to use resets.');
      const [result] = await this.request(binary, [['account/rateLimitResetCredit/consume', { idempotencyKey: randomUUID(), ...(creditId ? { creditId } : {}) }]]);
      if (!OUTCOMES.has(result?.outcome)) throw new Error('Codex returned an unknown reset result.');
      return result.outcome;
    });
  }

  serial(work) {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async findBinary() {
    if (this.binary !== undefined) return this.binary;
    for (const candidate of this.candidates) {
      try { await access(candidate, constants.X_OK); this.binary = candidate; return candidate; } catch { /* Try the next location. */ }
    }
    // Not cached: Codex may be installed while Handwork is open.
    return null;
  }

  /** One app-server session: initialize, then each call in order. */
  request(binary, calls) {
    return new Promise((resolve, reject) => {
      const child = this.spawn(binary, ['app-server'], { env: this.env, stdio: ['pipe', 'pipe', 'ignore'] });
      const pending = new Map();
      let nextId = 0, buffer = '', settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); child.kill();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Codex did not respond. Try again.')), this.timeout);
      const send = message => child.stdin.write(JSON.stringify(message) + '\n');
      const call = (method, params) => new Promise((done, fail) => { const id = ++nextId; pending.set(id, { done, fail }); send({ id, method, params }); });
      child.on('error', cause => finish(new Error(`Could not start Codex: ${cause.message}`)));
      child.on('exit', () => finish(new Error('Codex stopped before answering.')));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message; try { message = JSON.parse(line); } catch { continue; }
          if (message.id != null && pending.has(message.id) && !message.method) {
            const { done, fail } = pending.get(message.id); pending.delete(message.id);
            if (message.error) fail(new Error(signInMessage(message.error.message) ?? message.error.message ?? 'Codex request failed.'));
            else done(message.result);
          } else if (message.id != null && message.method) {
            // Decline anything the server asks of us; these calls need no approvals.
            send({ id: message.id, result: {} });
          }
        }
      });
      (async () => {
        await call('initialize', { clientInfo: { name: 'handwork', title: 'Handwork', version: '1' }, capabilities: { experimentalApi: true } });
        send({ method: 'initialized' });
        const results = [];
        for (const entry of calls) {
          const [method, params] = Array.isArray(entry) ? entry : [entry, {}];
          results.push(await call(method, params));
        }
        return results;
      })().then(results => finish(null, results), cause => finish(cause));
    });
  }
}

function signInMessage(message = '') {
  return /not signed in|authentication required|not authenticated|login/i.test(message) ? 'Sign in to Codex to use resets.' : undefined;
}

/** Codex binaries in the order a person most likely keeps them current. */
export function codexCandidates(env = process.env, platform = process.platform) {
  const home = env.HOME || homedir();
  const name = platform === 'win32' ? 'codex.exe' : 'codex';
  const bundled = platform === 'darwin' ? [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
    path.join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
  ] : [];
  // Apps opened from the Dock do not inherit the shell's PATH.
  const common = platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), path.join(home, '.cargo/bin')];
  const listed = (env.PATH || '').split(path.delimiter).filter(Boolean);
  return [...new Set([...bundled, ...[...listed, ...common].map(directory => path.join(directory, name))])];
}

function parseCredits(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = Number(raw.availableCount ?? raw.available_count);
  if (!Number.isFinite(count)) return null;
  const seconds = value => Number.isFinite(value) && value > 0 ? value * (value < 1e12 ? 1000 : 1) : null;
  const credits = Array.isArray(raw.credits) ? raw.credits
    .filter(credit => credit && typeof credit.id === 'string' && credit.id && (credit.status === 'available' || credit.status === undefined))
    .map(credit => ({
      id: credit.id,
      title: typeof credit.title === 'string' ? credit.title : null,
      description: typeof credit.description === 'string' ? credit.description : null,
      expiresAt: seconds(credit.expiresAt ?? credit.expires_at),
    })) : [];
  return { availableCount: Math.max(0, Math.floor(count)), credits };
}
