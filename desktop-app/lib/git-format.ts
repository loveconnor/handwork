import type { GitChange, GitOperation, GitRepositoryState } from './desktop-api';

export type FileStatus = 'Conflict' | 'Deleted' | 'Renamed' | 'Added' | 'Modified';
type Repository = Extract<GitRepositoryState, { kind: 'repository' }>;

/** Status letters from `git status` and `git show --name-status`. */
export function changeStatus(change: Pick<GitChange, 'status' | 'untracked' | 'conflict'>): FileStatus {
  if (change.conflict || change.status.includes('U')) return 'Conflict';
  if (change.status.includes('D')) return 'Deleted';
  if (change.status.includes('R')) return 'Renamed';
  if (change.untracked || /[AC?]/.test(change.status)) return 'Added';
  return 'Modified';
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

export function relativeTime(time: number, now = Date.now()) {
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) return 'just now';
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, size] of [['minute', 60], ['hour', 3600], ['day', 86400], ['week', 604800]] as const) {
    const next = { minute: 3600, hour: 86400, day: 604800, week: 2629800 }[unit];
    if (seconds < next) return format.format(-Math.max(1, Math.round(seconds / size)), unit);
  }
  return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: now - time > 300 * 86400000 ? 'numeric' : undefined });
}

/** What the person reviewed; the commit is refused if any of it changed. */
export const reviewedCommit = (state: Repository) => ({ repository: state.repository, branch: state.head.branch, head: state.head.oid, index: state.index });

export const operationLabel: Record<GitOperation, string> = {
  stage: 'Staging', unstage: 'Unstaging', commit: 'Committing', push: 'Pushing', publish: 'Publishing', fetch: 'Fetching', pull: 'Pulling', switch: 'Switching branches', branch: 'Creating branch',
};

/** A one-line description of how the branch relates to its remote. */
export function syncDescription(state: Repository) {
  if (!state.remotes.length) return 'No remote configured';
  if (state.head.detached) return 'Detached HEAD';
  if (state.head.unborn) return 'No commits yet';
  if (state.upstream?.gone) return `${state.upstream.name} was deleted on the remote`;
  if (state.publish) return state.publish.reason === 'mismatch' ? `Tracks ${state.upstream?.name}, but pushes nowhere` : 'Not published';
  if (state.push && !state.ahead && !state.behind && !state.push.outgoing) return `Up to date with ${state.upstream?.name ?? `${state.push.remote}/${state.push.branch}`}`;
  return `Tracking ${state.upstream?.name ?? `${state.push?.remote}/${state.push?.branch}`}`;
}

/** Keys the saved commit draft by repository so it survives closing the panel or a failed commit. */
export const draftKey = (repository: string) => `handwork.commitDraft:${repository}`;
