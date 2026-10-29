// Only SDK rate_limit_event data: never reads OAuth tokens or private usage APIs.
const labels = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet', seven_day_overage_included: 'Weekly included extra usage', overage: 'Extra usage' };
let account;
let generation = 0;
let windows = new Map();
let observedAt = null;
export function claudeUsageAccount(status) {
  const identity = status?.loggedIn ? JSON.stringify([status.email ?? null, status.orgId ?? null, status.authMethod ?? null]) : null;
  if (identity !== account) { account = identity; generation++; windows = new Map(); observedAt = null; }
  return generation;
}
export function claudeUsageGeneration() { return generation; }
export function recordClaudeUsage(info, expectedGeneration = generation) {
  if (expectedGeneration !== generation || !info || !Object.hasOwn(labels, info.rateLimitType)) return;
  const usedPercent = typeof info.utilization === 'number' && Number.isFinite(info.utilization) && info.utilization >= 0 && info.utilization <= 1 ? info.utilization * 100 : info.status === 'rejected' ? 100 : null;
  const resetsAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) && info.resetsAt > 0 ? info.resetsAt * 1000 : null;
  windows.set(info.rateLimitType, { id: info.rateLimitType, label: labels[info.rateLimitType], usedPercent, resetsAt, windowMinutes: info.rateLimitType === 'five_hour' ? 300 : info.rateLimitType.startsWith('seven_day') ? 10080 : null });
  observedAt = Date.now();
}
export function readClaudeUsage() { return { plan: null, windows: [...windows.values()], observedAt, source: 'sdk-events' }; }
