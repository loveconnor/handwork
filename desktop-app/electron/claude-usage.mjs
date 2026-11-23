// Plan limits come from Claude Code itself: its /usage report and the
// rate_limit_event messages of chats. Handwork never reads OAuth tokens or
// calls private usage APIs directly.
const labels = { five_hour: '5-hour', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet', seven_day_overage_included: 'Weekly included extra usage', overage: 'Extra usage' };
const windowMinutes = id => id === 'five_hour' ? 300 : id.startsWith('seven_day') || id.startsWith('model:') ? 10080 : null;
let account;
let generation = 0;
let windows = new Map();
let observedAt = null;
let plan = null;
let available = true;
let reportedAt = 0;
export function claudeUsageAccount(status) {
  const identity = status?.loggedIn ? JSON.stringify([status.email ?? null, status.orgId ?? null, status.authMethod ?? null]) : null;
  if (identity !== account) { account = identity; generation++; windows = new Map(); observedAt = null; plan = null; available = true; reportedAt = 0; }
  return generation;
}
export function claudeUsageGeneration() { return generation; }
/** When the last full /usage report arrived, so callers can pace refreshes. */
export function claudeUsageReportedAt() { return reportedAt; }
export function recordClaudeUsage(info, expectedGeneration = generation) {
  if (expectedGeneration !== generation || !info || !Object.hasOwn(labels, info.rateLimitType)) return;
  const usedPercent = typeof info.utilization === 'number' && Number.isFinite(info.utilization) && info.utilization >= 0 && info.utilization <= 1 ? info.utilization * 100 : info.status === 'rejected' ? 100 : null;
  const resetsAt = typeof info.resetsAt === 'number' && Number.isFinite(info.resetsAt) && info.resetsAt > 0 ? info.resetsAt * 1000 : null;
  windows.set(info.rateLimitType, { id: info.rateLimitType, label: labels[info.rateLimitType], usedPercent, resetsAt, windowMinutes: windowMinutes(info.rateLimitType) });
  observedAt = Date.now();
}

const percent = value => typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
const isoTime = value => { const at = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(at) && at > 0 ? at : null; };

/** Replaces the windows with Claude Code's /usage answer, which lists every
 *  plan window at once rather than the one a chat happened to touch. */
export function recordClaudeUsageReport(report, expectedGeneration = generation) {
  if (expectedGeneration !== generation || !report || typeof report !== 'object') return;
  const next = new Map();
  const limits = report.rate_limits && typeof report.rate_limits === 'object' ? report.rate_limits : null;
  for (const id of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
    const row = limits?.[id];
    if (!row || typeof row !== 'object') continue;
    const usedPercent = percent(row.utilization);
    if (usedPercent === null && !row.resets_at) continue;
    next.set(id, { id, label: labels[id], usedPercent, resetsAt: isoTime(row.resets_at), windowMinutes: windowMinutes(id) });
  }
  for (const row of Array.isArray(limits?.model_scoped) ? limits.model_scoped : []) {
    if (!row || typeof row.display_name !== 'string' || !row.display_name.trim()) continue;
    const id = `model:${row.display_name.trim()}`;
    if (next.has(id)) continue;
    next.set(id, { id, label: `Weekly ${row.display_name.trim()}`, usedPercent: percent(row.utilization), resetsAt: isoTime(row.resets_at), windowMinutes: windowMinutes(id) });
  }
  const extra = limits?.extra_usage;
  if (extra?.is_enabled && percent(extra.utilization) !== null) next.set('overage', { id: 'overage', label: labels.overage, usedPercent: percent(extra.utilization), resetsAt: null, windowMinutes: null });
  windows = next;
  plan = typeof report.subscription_type === 'string' && report.subscription_type ? report.subscription_type : null;
  available = report.rate_limits_available !== false;
  observedAt = reportedAt = Date.now();
}

export function readClaudeUsage() { return { plan, windows: [...windows.values()], observedAt, source: 'sdk-events', available }; }
