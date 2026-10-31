import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeUsageAccount, recordClaudeUsage, readClaudeUsage } from '../../electron/claude-usage.mjs';
import { validateArguments } from '../../electron/ipc.mjs';

test('Claude usage preserves reported windows, percentages and reset times', () => {
  const generation = claudeUsageAccount({ loggedIn: true, email: 'one@example.test' });
  assert.deepEqual(readClaudeUsage().windows, []);
  recordClaudeUsage({ rateLimitType: 'five_hour', utilization: 0.25, resetsAt: 1800000000, status: 'allowed' }, generation);
  recordClaudeUsage({ rateLimitType: 'seven_day', utilization: 0.8, resetsAt: 1800600000, status: 'allowed_warning' }, generation);
  const usage = readClaudeUsage();
  assert.equal(usage.windows.length, 2);
  assert.equal(usage.windows[0].usedPercent, 25);
  assert.equal(usage.windows[0].resetsAt, 1800000000000);
  assert.ok(usage.observedAt > 0);
  recordClaudeUsage({ rateLimitType: 'five_hour', status: 'allowed' }, generation);
  assert.equal(readClaudeUsage().windows[0].usedPercent, null);
  assert.equal(readClaudeUsage().windows[0].resetsAt, null);
  recordClaudeUsage({ rateLimitType: 'five_hour', status: 'rejected' }, generation);
  assert.equal(readClaudeUsage().windows[0].usedPercent, 100);
  claudeUsageAccount({ loggedIn: true, email: 'two@example.test' });
  recordClaudeUsage({ rateLimitType: 'five_hour', utilization: 0.5 }, generation);
  assert.deepEqual(readClaudeUsage().windows, [], 'old-account events cannot populate a new account');
  claudeUsageAccount(null);
  assert.equal(readClaudeUsage().observedAt, null);
});

test('usage IPC admits only implemented providers', () => {
  validateArguments('providerUsage', ['claude']);
  validateArguments('providerUsage', ['codex']);
  assert.throws(() => validateArguments('providerUsage', ['invented']));
});
