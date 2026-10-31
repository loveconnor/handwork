import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DesktopBackend } from '../../electron/backend.mjs';
import { validateArguments } from '../../electron/ipc.mjs';
import { usageResetLabel, usageWindowState } from '../../lib/subscription-usage.ts';

test('sidebar usage is an icon in the settings row with hover and click details', () => {
  const component = readFileSync(new URL('../../components/site/HandworkSubscriptionUsage.tsx', import.meta.url), 'utf8');
  const harness = readFileSync(new URL('../../components/site/HandworkHarness.tsx', import.meta.url), 'utf8');
  assert.match(component, /PopoverTrigger openOnHover delay=\{300\} closeDelay=\{150\}/);
  assert.match(component, /size="icon-sm" className=\{styles.summary\} aria-label=\{`\$\{name\} subscription usage and reset times`\}/);
  assert.match(component, /<ProviderLogo provider=\{provider\} size=\{18\}/);
  const css = readFileSync(new URL('../../components/site/HandworkSubscriptionUsage.module.css', import.meta.url), 'utf8');
  assert.match(css, /\.summary \{ margin-left: auto; flex-shrink: 0;/);
  const logos = readFileSync(new URL('../../components/site/ProviderLogo.tsx', import.meta.url), 'utf8');
  assert.match(logos, /codex: OpenAI/);
  assert.doesNotMatch(component, /styles\.(summaryLabel|rings|ringValue)/);
  assert.match(component, /if \(!active\) return null/);
  assert.match(harness, /className="handwork-provider-usage-icons"/);
  assert.match(harness, /provider.connected && \['codex', 'claude'\].includes\(provider.id\)/);
  assert.match(component, /provider !== 'codex' \|\| !api\?\.codexResets/);
});

const now = Date.UTC(2026, 9, 18, 12);
const window = (usedPercent, resetsAt = now + 60_000) => ({ id: 'weekly', label: 'Weekly', usedPercent, resetsAt, windowMinutes: 10080 });

test('remaining allowance distinguishes zero, exhausted, absent reset and passed resets', () => {
  assert.deepEqual(usageWindowState(window(0), now), { remaining: 100, expired: false, exhausted: false, low: false });
  assert.deepEqual(usageWindowState(window(100), now), { remaining: 0, expired: false, exhausted: true, low: true });
  assert.equal(usageWindowState(window(95.5), now).remaining, 4.5);
  assert.equal(usageWindowState(window(25, null), now).remaining, 75);
  assert.equal(usageWindowState(window(100, now), now).remaining, null, 'do not claim that a reset restored quota');
  for (const percent of [NaN, Infinity, -1, 101]) assert.equal(usageWindowState(window(percent), now).remaining, null);
});

test('reset labels use the reported deadline without inventing a schedule', () => {
  assert.equal(usageResetLabel(null, now), 'Reset time unavailable');
  assert.equal(usageResetLabel(now, now), 'Reset time reached. Refreshing allowance…');
  assert.equal(usageResetLabel(now + 1, now), 'Resets in 1 min');
  assert.equal(usageResetLabel(now + 65 * 60_000, now), 'Resets in 1 hr 5 min');
  assert.equal(usageResetLabel(now + 25 * 60 * 60_000, now), 'Resets in 1 day 1 hr');
  assert.equal(usageResetLabel(now + 7 * 24 * 60 * 60_000, now), 'Resets in 7 days');
});

test('usage IPC is narrow and exposed by the sandboxed preload', () => {
  validateArguments('providerUsage', ['codex']);
  for (const args of [[], ['openai'], ['codex', true], [{ provider: 'codex' }]]) assert.throws(() => validateArguments('providerUsage', args), /Invalid desktop API arguments/);
  assert.match(readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8'), /'providerUsage'/);
});

test('usage checks coalesce in a disposable background engine without touching a live chat', async () => {
  const calls = [];
  let finish;
  let disposed = 0;
  const usage = { plan: 'plus', windows: [window(42)] };
  const backend = new DesktopBackend({ clientFactory: options => {
    assert.equal(options.env.HANDWORK_AUTH_MODE, 'host-managed');
    return {
      exited: Promise.resolve(),
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'initialize') return { agentCapabilities: { handwork: { backgroundTask: true } } };
        return new Promise(resolve => { finish = () => resolve(usage); });
      },
      dispose() { disposed++; },
    };
  } });
  backend.client = { closed: false, request() { assert.fail('usage must not run on the chat connection'); } };
  const first = backend.providerUsage('codex');
  const second = backend.providerUsage('codex');
  assert.equal(first, second);
  await Promise.resolve();
  finish();
  assert.deepEqual(await first, usage);
  assert.equal(disposed, 1);
  assert.equal(backend.settingsClients.size, 0);
  assert.equal(backend.session, null);
  assert.equal(backend.engines.size, 0);
  assert.deepEqual(calls, [
    { method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { handwork: { backgroundTask: true } } } },
    { method: 'handwork/providers/usage', params: { provider: 'codex' } },
  ]);
  backend.client = null;
  await backend.dispose();
});

test('failed usage checks release their engine and can retry; other providers never spawn one', async () => {
  let attempts = 0;
  let disposed = 0;
  const backend = new DesktopBackend({ clientFactory: () => ({
    exited: Promise.resolve(),
    async request(method) {
      if (method === 'initialize') return { agentCapabilities: { handwork: { backgroundTask: true } } };
      if (++attempts === 1) throw new Error('Usage is unavailable. Please try again.');
      return { plan: null, windows: [] };
    },
    dispose() { disposed++; },
  }) });
  await assert.rejects(backend.providerUsage('openai'), /only available for Codex/);
  assert.equal(disposed, 0);
  await assert.rejects(backend.providerUsage('codex'), /Usage is unavailable/);
  assert.equal(backend.settingsClients.size, 0);
  assert.deepEqual(await backend.providerUsage('codex'), { plan: null, windows: [] });
  assert.equal(disposed, 2);
  await backend.dispose();
});

test('an older engine gets an actionable usage error', async () => {
  const backend = new DesktopBackend({ clientFactory: () => ({
    exited: Promise.resolve(),
    async request(method) {
      if (method === 'initialize') return { agentCapabilities: { handwork: { backgroundTask: true } } };
      throw new Error('Method not found');
    },
    dispose() {},
  }) });
  await assert.rejects(backend.providerUsage('codex'), /Update the Handwork engine/);
  assert.equal(backend.settingsClients.size, 0);
  await backend.dispose();
});

test('usage checks respect the background process limit', async () => {
  const backend = new DesktopBackend({ clientFactory() { assert.fail('must not spawn an unbounded check'); } });
  backend.settingsClients = new Set([1, 2, 3]);
  await assert.rejects(backend.providerUsage('codex'), /already running/);
  backend.settingsClients.clear();
  await backend.dispose();
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexResets, codexCandidates } from '../../electron/codex-resets.mjs';
import { resetCreditExpiry } from '../../lib/subscription-usage.ts';

/** A fake `codex app-server` that answers each JSON-RPC line from a table. */
function fakeCodex(answers, seen = []) {
  return (binary, args) => {
    assert.deepEqual(args, ['app-server']);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough();
    child.kill = () => { child.killed = true; };
    let buffer = '';
    child.stdin.on('data', chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        seen.push(message);
        if (message.id == null) continue;
        const answer = answers[message.method];
        child.stdout.write(JSON.stringify(answer?.error ? { id: message.id, error: answer.error } : { id: message.id, result: answer ?? {} }) + '\n');
      }
    });
    return child;
  };
}

test('banked Codex resets are read with the account they belong to', async () => {
  const resets = new CodexResets({ candidates: [process.execPath], spawn: fakeCodex({
    'account/read': { account: { email: 'me@example.com' } },
    'account/rateLimits/read': { rateLimitResetCredits: { availableCount: 3, credits: [
      { id: 'a', status: 'available', title: 'Full reset', description: 'Thanks', expiresAt: 1793301096 },
      { id: 'b', status: 'redeemed', title: 'Used' },
    ] } },
  }) });
  assert.deepEqual(await resets.read(), { email: 'me@example.com', availableCount: 3, credits: [{ id: 'a', title: 'Full reset', description: 'Thanks', expiresAt: 1793301096000 }] });
});

test('using a reset names the credit, sends a fresh idempotency key and rejects unknown results', async () => {
  const seen = [];
  const resets = new CodexResets({ candidates: [process.execPath], spawn: fakeCodex({ 'account/rateLimitResetCredit/consume': { outcome: 'reset' } }, seen) });
  assert.equal(await resets.use('a'), 'reset');
  const consume = seen.find(message => message.method === 'account/rateLimitResetCredit/consume');
  assert.equal(consume.params.creditId, 'a');
  assert.match(consume.params.idempotencyKey, /^[0-9a-f-]{36}$/);
  const odd = new CodexResets({ candidates: [process.execPath], spawn: fakeCodex({ 'account/rateLimitResetCredit/consume': { outcome: 'surprise' } }) });
  await assert.rejects(odd.use(null), /unknown reset result/);
  const signedOut = new CodexResets({ candidates: [process.execPath], spawn: fakeCodex({ 'account/rateLimitResetCredit/consume': { error: { message: 'not signed in' } } }) });
  await assert.rejects(signedOut.use(null), /Sign in to Codex/);
});

test('resets are absent, not an error, when Codex is not installed', async () => {
  const resets = new CodexResets({ candidates: ['/nonexistent/codex'], spawn: () => assert.fail('must not spawn') });
  assert.equal(await resets.read(), null);
  await assert.rejects(resets.use(null), /Codex is not installed/);
  assert.equal(codexCandidates({ HOME: '/home/me', PATH: '/bin' }, 'darwin')[0], '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex');
});

test('reset IPC accepts only a credit id or null', () => {
  validateArguments('codexResets', []);
  validateArguments('useCodexReset', [null]);
  validateArguments('useCodexReset', ['credit_123-abc']);
  for (const args of [[], [42], ['../x'], ['a b'], [{}]]) assert.throws(() => validateArguments('useCodexReset', args), /Invalid desktop API arguments/);
  const preload = readFileSync(new URL('../../electron/preload.cjs', import.meta.url), 'utf8');
  assert.match(preload, /'codexResets', 'useCodexReset'/);
});

test('reset expiry reads like the usage countdowns', () => {
  assert.equal(resetCreditExpiry(null, now), 'No expiry');
  assert.equal(resetCreditExpiry(now - 1, now), 'Expires now');
  assert.equal(resetCreditExpiry(now + 3 * 24 * 60 * 60_000 + 4 * 60 * 60_000, now), 'Expires in 3 days 4 hr');
});
