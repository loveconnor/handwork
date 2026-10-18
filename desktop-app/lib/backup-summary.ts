import type { BackupPreview, RestoreCategory, RestoreResult } from './desktop-api';

/** Which parts of a backup have anything to restore; those start selected. */
export function restoreChoices(preview: BackupPreview): Record<RestoreCategory, boolean> {
  return { chats: preview.chats.new > 0, prompts: preview.prompts.new > 0, preferences: preview.preferences, unsent: preview.unsent.drafts + preview.unsent.queued > 0 };
}

const count = (value: number, noun: string) => `${value} ${noun}${value === 1 ? '' : 's'}`;

/** One sentence describing what a restore added. */
export function restoreSummary(result: RestoreResult): string {
  const parts = [
    result.chats && count(result.chats, 'chat'),
    result.prompts && count(result.prompts, 'saved prompt'),
    result.projects && count(result.projects, 'project'),
    result.drafts && count(result.drafts, 'draft'),
    result.queued && count(result.queued, 'queued message'),
    result.preferences && 'your preferences',
  ].filter((part): part is string => !!part);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  const kept = result.skippedChats ? ` ${count(result.skippedChats, 'chat')} already here ${result.skippedChats === 1 ? 'was' : 'were'} kept as is.` : '';
  const overflow = [result.skippedDrafts && count(result.skippedDrafts, 'draft'), result.skippedQueued && count(result.skippedQueued, 'queued message')].filter(Boolean).join(' and ');
  const skipped = overflow ? ` Skipped ${overflow} because the unsent storage limit was reached. Existing unsent work was kept. Skipped work remains in the backup.` : '';
  const paused = result.queued ? ' Queued messages are paused until you review them.' : '';
  return list ? `Restored ${list}.${kept}${skipped}${paused}` : `Nothing new to restore.${kept}${skipped}`;
}
