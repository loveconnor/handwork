import type { QueuedMessage, SavedQueue } from './desktop-api';

export type Queues = Record<string, QueuedMessage[]>;

/** What a saved queue contains, to skip saving when nothing changed. Queued messages never change in place. */
export function queueKey(items: QueuedMessage[], paused: boolean): string {
  return items.length ? `${paused ? 'paused' : 'ready'}:${items.map(item => item.id).join(',')}` : '';
}

/** Queues saved before a restart come back paused, so nothing sends before the person has looked. */
export function restoreQueues(saved: SavedQueue[]): { queues: Queues; paused: Set<string>; keys: Map<string, string>; count: number } {
  const queues: Queues = {};
  const keys = new Map<string, string>();
  let count = 0;
  for (const queue of saved) {
    if (!queue.items.length) continue;
    queues[queue.sessionId] = queue.items;
    // The saved key records the pause state on disk; a resume saves the change.
    keys.set(queue.sessionId, queueKey(queue.items, queue.paused));
    count += queue.items.length;
  }
  return { queues, paused: new Set(Object.keys(queues)), keys, count };
}

/** Adds queues restored from a backup to chats that have none open now. */
export function mergeQueues(current: Queues, saved: SavedQueue[]): { queues: Queues; added: string[] } {
  const queues = { ...current };
  const added: string[] = [];
  for (const queue of saved) {
    if (!queue.items.length || current[queue.sessionId]?.length) continue;
    queues[queue.sessionId] = queue.items;
    added.push(queue.sessionId);
  }
  return { queues, added };
}

/**
 * Chats whose next queued message can send now. Each queue belongs to its chat, so
 * a chat in the background keeps sending while the person reads another one.
 * Slash commands act on the open chat, so they wait until their chat is open.
 */
export function readyQueues({ queues, paused, running, active, activeBlocked, opening, isCommand }: {
  queues: Queues; paused: Set<string>; running: Set<string>; active: string; activeBlocked: boolean; opening?: string;
  isCommand: (item: QueuedMessage) => boolean;
}): { session: string; item: QueuedMessage }[] {
  return Object.entries(queues).flatMap(([session, items]) => {
    const item = items[0];
    if (!item || paused.has(session) || running.has(session) || session === opening) return [];
    if (session === active ? activeBlocked : isCommand(item)) return [];
    return [{ session, item }];
  });
}

/** Queued messages per chat, for the sidebar. */
export function queueCounts(queues: Queues): Map<string, number> {
  return new Map(Object.entries(queues).filter(([, items]) => items.length).map(([session, items]) => [session, items.length]));
}
