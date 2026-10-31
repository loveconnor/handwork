/** Why a chat is listed in the attention view, most urgent first. */
export type AttentionKind = 'approval' | 'failed' | 'interrupted' | 'queue' | 'running';
export type ChatIssue = { kind: 'failed' | 'interrupted'; message: string };
export type AttentionItem = { id: string; label: string; workspace?: string; kind: AttentionKind; detail: string };

const order: AttentionKind[] = ['approval', 'failed', 'interrupted', 'queue', 'running'];
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const short = (text: string, max = 90) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

/**
 * Chats that need the person, then chats that are working. Each chat appears once,
 * under the most urgent thing it is waiting for.
 */
export function attentionItems({ chats, approvals, issues, recoverable, pausedQueues, running, queued }: {
  chats: { id: string; label: string; workspace?: string }[];
  approvals: Map<string, number>; issues: Record<string, ChatIssue>; recoverable: Set<string>;
  pausedQueues: Map<string, number>; running: Set<string>; queued: Map<string, number>;
}): AttentionItem[] {
  const known = new Map(chats.map(chat => [chat.id, chat]));
  const ids = new Set([...approvals.keys(), ...Object.keys(issues), ...recoverable, ...pausedQueues.keys(), ...running]);
  const items: AttentionItem[] = [];
  for (const id of ids) {
    const chat = known.get(id);
    const base = { id, label: chat?.label || 'Chat', workspace: chat?.workspace };
    const approval = approvals.get(id) ?? 0;
    const issue = Object.hasOwn(issues, id) ? issues[id] : undefined;
    const paused = pausedQueues.get(id) ?? 0;
    if (approval) items.push({ ...base, kind: 'approval', detail: approval === 1 ? 'Waiting for your approval' : `${approval} approvals waiting` });
    else if (issue?.kind === 'failed') items.push({ ...base, kind: 'failed', detail: short(issue.message) || 'The reply could not finish' });
    else if (recoverable.has(id) || issue?.kind === 'interrupted') items.push({ ...base, kind: 'interrupted', detail: short(issue?.message ?? '') || 'Reply paused. You can retry it.' });
    else if (paused) items.push({ ...base, kind: 'queue', detail: `Queue paused · ${plural(paused, 'message')} waiting` });
    else if (running.has(id)) { const waiting = queued.get(id) ?? 0; items.push({ ...base, kind: 'running', detail: waiting ? `Working · ${waiting} queued` : 'Working' }); }
  }
  return items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

/** The next chat that needs the person after the one shown, wrapping around. */
export function nextAttention(items: AttentionItem[], current: string): AttentionItem | undefined {
  const actionable = items.filter(item => item.kind !== 'running');
  if (!actionable.length) return undefined;
  const index = actionable.findIndex(item => item.id === current);
  return actionable[(index + 1) % actionable.length];
}
