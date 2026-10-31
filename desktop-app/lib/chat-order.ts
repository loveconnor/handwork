type Chat = { id: string; label: string; workspace?: string; updatedAt?: string; pinned?: boolean };

const activityTime = (chat: Chat) => {
  const timestamp = Date.parse(chat.updatedAt ?? '');
  return Number.isFinite(timestamp) ? timestamp : 0;
};

/** Open tabs retain their labels and workspace, but must not lose saved activity dates. */
export function mergeSidebarChats<T extends Chat>(tabs: T[], sessions: T[], projects: string[]): T[] {
  const saved = new Map(sessions.map(chat => [chat.id, chat]));
  const open = new Set(tabs.map(chat => chat.id));
  return [
    ...tabs.map(tab => {
      const session = saved.get(tab.id);
      return { ...session, ...tab, updatedAt: session && activityTime(session) > activityTime(tab) ? session.updatedAt : tab.updatedAt };
    }),
    ...sessions.filter(chat => !open.has(chat.id) && (!chat.workspace || projects.includes(chat.workspace))),
  ];
}

/** Pinned chats stay first; each group is newest first, with stable ties and unknown dates last. */
export function sortChatsByRecency<T extends Chat>(chats: T[]): T[] {
  return [...chats].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || activityTime(b) - activityTime(a));
}
