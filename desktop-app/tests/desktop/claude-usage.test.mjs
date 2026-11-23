import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeUsageAccount, claudeUsageReportedAt, recordClaudeUsage, recordClaudeUsageReport, readClaudeUsage } from '../../electron/claude-usage.mjs';
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

test('a Claude Code /usage report lists every plan window at once', () => {
  const generation = claudeUsageAccount({ loggedIn: true, email: 'three@example.test' });
  recordClaudeUsageReport({
    subscription_type: 'max', rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12, resets_at: '2026-11-22T18:00:00Z' },
      seven_day: { utilization: 140, resets_at: null },
      seven_day_opus: null,
      model_scoped: [{ display_name: 'Fable', utilization: 3, resets_at: '2026-11-28T00:00:00Z' }],
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    },
  }, generation);
  const usage = readClaudeUsage();
  assert.equal(usage.plan, 'max');
  assert.equal(usage.available, true);
  assert.deepEqual(usage.windows.map(item => [item.id, item.usedPercent]), [['five_hour', 12], ['seven_day', 100], ['model:Fable', 3]]);
  assert.equal(usage.windows[0].resetsAt, Date.parse('2026-11-22T18:00:00Z'));
  assert.ok(claudeUsageReportedAt() > 0);
  recordClaudeUsageReport({ subscription_type: null, rate_limits_available: false, rate_limits: null }, generation);
  assert.equal(readClaudeUsage().available, false);
  assert.deepEqual(readClaudeUsage().windows, []);
  recordClaudeUsageReport({ rate_limits: { five_hour: { utilization: 50 } } }, generation - 1);
  assert.deepEqual(readClaudeUsage().windows, [], 'a report started for another account is ignored');
});
