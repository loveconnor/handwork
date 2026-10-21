import type { AttentionKind } from './attention';

type Chat = { id: string; pinned?: boolean; updatedAt?: string };

export function readSidebarKeys(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? [...new Set(parsed)] : [];
  } catch { return []; }
}

/** Keep existing rows in place when background activity updates their timestamps. */
export function orderSidebarChats<T extends Chat>(chats: T[], previous: string[]): T[] {
  const ranks = new Map(previous.map((id, index) => [id, index]));
  return [...chats].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)
    || (ranks.get(a.id) ?? -1) - (ranks.get(b.id) ?? -1));
}

export function visibleSidebarChats<T extends Chat>(chats: T[], expanded: boolean, current: string, attention?: Map<string, AttentionKind>, running?: Set<string>) {
  if (expanded) return chats;
  return chats.filter((chat, index) => index < 5 || chat.pinned || chat.id === current || attention?.has(chat.id) || running?.has(chat.id));
}

export function sidebarChatTime(updatedAt: string | undefined, now: number): string {
  const at = Date.parse(updatedAt ?? '');
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}
