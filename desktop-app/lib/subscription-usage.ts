import type { SubscriptionUsageWindow } from './desktop-api';

/** A passed reset is not proof that OpenAI has restored an allowance. */
export function usageWindowState(window: SubscriptionUsageWindow, now: number) {
  const expired = window.resetsAt !== null && window.resetsAt <= now;
  const valid = Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100;
  const remaining = expired || !valid ? null : Math.round((100 - window.usedPercent) * 10) / 10;
  return { remaining, expired, exhausted: remaining === 0, low: remaining !== null && remaining <= 10 };
}

export function usageResetLabel(resetsAt: number | null, now: number) {
  if (resetsAt === null || !Number.isFinite(resetsAt)) return 'Reset time unavailable';
  if (resetsAt <= now) return 'Reset time reached. Refreshing allowance…';
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes < 60) return `Resets in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Resets in ${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  const days = Math.floor(hours / 24);
  return `Resets in ${days} day${days === 1 ? '' : 's'}${hours % 24 ? ` ${hours % 24} hr` : ''}`;
}
