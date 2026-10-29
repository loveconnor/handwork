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

/** Where a chat stands, for the status layout: one tab per chat, most urgent first. */
export type ChatStatus = 'needs' | 'working' | 'active' | 'settled';
export const CHAT_STATUSES: { id: ChatStatus; label: string; empty: string }[] = [
  { id: 'needs', label: 'Inbox', empty: 'Nothing is waiting on you.' },
  { id: 'working', label: 'Working', empty: 'No chats are working right now.' },
  { id: 'active', label: 'Active', empty: 'No open or recent chats.' },
  { id: 'settled', label: 'Settled', empty: 'No settled chats.' },
];
export const DEFAULT_STATUS_TABS: ChatStatus[] = ['needs', 'working', 'active'];
const ACTIVE_WINDOW_MS = 24 * 60 * 60_000;

/**
 * A blocked reply (approval, failure, pause) needs the person even while the
 * chat runs; an unread reply needs them only once it has stopped. Open tabs,
 * pins and the last day's chats are active; everything else has settled.
 */
export function chatStatus(chat: Chat, state: { attention?: Map<string, AttentionKind>; running?: Set<string>; unread?: Set<string>; open?: string[]; now: number }): ChatStatus {
  const flag = state.attention?.get(chat.id);
  if (flag && flag !== 'running') return 'needs';
  if (state.running?.has(chat.id)) return 'working';
  if (state.unread?.has(chat.id)) return 'needs';
  const updated = Date.parse(chat.updatedAt ?? '');
  if (chat.pinned || state.open?.includes(chat.id) || (Number.isFinite(updated) && state.now - updated < ACTIVE_WINDOW_MS)) return 'active';
  return 'settled';
}

/** The saved tab selection, never empty and only known tabs. */
export function readStatusTabs(value: string | null): ChatStatus[] {
  const known = new Set(CHAT_STATUSES.map(item => item.id));
  const tabs = readSidebarKeys(value).filter((item): item is ChatStatus => known.has(item as ChatStatus));
  return tabs.length ? tabs : DEFAULT_STATUS_TABS;
}
