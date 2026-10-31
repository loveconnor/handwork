/** A chat made by editing or retrying turn `turn` of chat `from`, at time `at`. */
export type ChatBranch = { from: string; turn: number; at: number };
type Preferences = Record<string, { branch?: ChatBranch } | undefined>;

const branchOf = (preferences: Preferences, id: string): ChatBranch | undefined =>
  Object.hasOwn(preferences, id) ? preferences[id]?.branch : undefined;

function versionNeighbours(preferences: Preferences, available: Set<string>) {
  const neighbours = new Map<string, string[]>();
  for (const id of available) {
    const from = branchOf(preferences, id)?.from;
    if (!from || !available.has(from)) continue;
    neighbours.set(id, [...(neighbours.get(id) ?? []), from]);
    neighbours.set(from, [...(neighbours.get(from) ?? []), id]);
  }
  return neighbours;
}

function linkedVersions(chatId: string, neighbours: Map<string, string[]>) {
  const family = new Set([chatId]);
  for (const id of family) for (const neighbour of neighbours.get(id) ?? []) family.add(neighbour);
  return family;
}

/** All saved sessions belonging to one chat, across edits of any turn. */
export function chatVersionIds(preferences: Preferences, chatId: string, available: Set<string>): Set<string> {
  return linkedVersions(chatId, versionNeighbours(preferences, available));
}

/** One row per chat. Keep the viewed version selected; otherwise use the newest. */
export function collapseChatVersions<T extends { id: string; workspace?: string }>(chats: T[], preferences: Preferences, current: string): T[] {
  const remaining = new Map(chats.map(chat => [chat.id, chat]));
  const workspaces = new Map<string | undefined, Set<string>>();
  for (const chat of chats) {
    if (!workspaces.has(chat.workspace)) workspaces.set(chat.workspace, new Set());
    workspaces.get(chat.workspace)!.add(chat.id);
  }
  const neighbours = new Map([...workspaces].map(([workspace, ids]) => [workspace, versionNeighbours(preferences, ids)]));
  const result: T[] = [];
  for (const chat of chats) {
    if (!remaining.has(chat.id)) continue;
    const family = linkedVersions(chat.id, neighbours.get(chat.workspace)!);
    result.push(family.has(current) ? remaining.get(current) ?? chat : chat);
    for (const id of family) remaining.delete(id);
  }
  return result;
}

/**
 * Every saved version of one user turn, oldest first: the original chat, then each
 * edit or retry of that turn. Chats outside `available` (deleted, or in a removed
 * project) are left out, so every result can be opened.
 */
export function versionFamily(preferences: Preferences, chatId: string, turn: number, available?: Set<string>): string[] {
  const usable = (id: string) => !available || available.has(id);
  let root = chatId;
  const seen = new Set([root]);
  for (let branch = branchOf(preferences, root); branch && branch.turn === turn && usable(branch.from) && !seen.has(branch.from); branch = branchOf(preferences, root)) {
    root = branch.from;
    seen.add(root);
  }
  const children = new Map<string, { id: string; at: number }[]>();
  for (const id of Object.keys(preferences)) {
    const branch = branchOf(preferences, id);
    if (!branch || branch.turn !== turn || !usable(id)) continue;
    children.set(branch.from, [...(children.get(branch.from) ?? []), { id, at: branch.at }]);
  }
  const descendants: { id: string; at: number }[] = [];
  const visited = new Set([root]);
  for (let queue = [root]; queue.length;) {
    const next: string[] = [];
    for (const parent of queue) for (const child of children.get(parent) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id); descendants.push(child); next.push(child.id);
    }
    queue = next;
  }
  // Versions read in the order they were made, whichever version each came from.
  return [root, ...descendants.sort((a, b) => a.at - b.at).map(item => item.id)];
}

/** User turns of a chat that have another saved version, in order. */
export function versionTurns(preferences: Preferences, chatId: string, available?: Set<string>): number[] {
  const turns = new Set<number>();
  const own = branchOf(preferences, chatId);
  if (own && (!available || available.has(own.from))) turns.add(own.turn);
  for (const id of Object.keys(preferences)) {
    const branch = branchOf(preferences, id);
    if (branch?.from === chatId && (!available || available.has(id))) turns.add(branch.turn);
  }
  return [...turns].sort((a, b) => a - b);
}

/** Where a chat sits among the versions of one turn, and its neighbours. */
export function versionPosition(preferences: Preferences, chatId: string, turn: number, available?: Set<string>) {
  const family = versionFamily(preferences, chatId, turn, available);
  const index = family.indexOf(chatId);
  if (family.length < 2 || index < 0) return undefined;
  return { index, total: family.length, previous: family[index - 1] as string | undefined, next: family[index + 1] as string | undefined };
}
