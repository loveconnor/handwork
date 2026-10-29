import type { SubscriptionUsageWindow } from './desktop-api';

/** A passed reset is not proof that OpenAI has restored an allowance. */
export function usageWindowState(window: SubscriptionUsageWindow, now: number) {
  const expired = window.resetsAt !== null && window.resetsAt <= now;
  const valid = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100;
  const remaining = expired || !valid ? null : Math.round((100 - (window.usedPercent ?? 0)) * 10) / 10;
  return { remaining, expired, exhausted: remaining === 0, low: remaining !== null && remaining <= 10 };
}

/** "1 hr 5 min", "3 days 4 hr": the largest two units, rounded up to the minute. */
export function durationLabel(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}${hours % 24 ? ` ${hours % 24} hr` : ''}`;
}

export function usageResetLabel(resetsAt: number | null, now: number) {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return 'Reset time unavailable';
  if (resetsAt <= now) return 'Reset time reached. Refreshing allowance…';
  return `Resets in ${durationLabel(resetsAt - now)}`;
}

/** A banked reset's deadline; one without a deadline is simply available. */
export function resetCreditExpiry(expiresAt: number | null, now: number) {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return 'No expiry';
  if (expiresAt <= now) return 'Expires now';
  return `Expires in ${durationLabel(expiresAt - now)}`;
}
