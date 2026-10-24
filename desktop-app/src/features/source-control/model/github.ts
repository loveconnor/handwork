import { invoke } from "@tauri-apps/api/core";
import { normalizeProjectPath } from "../../projects/model/recents";
export type GithubTaskKind = "issue" | "pr";
export type GithubLabel = {
  name: string;
  color: string;
};
export type GithubAssignee = {
  login: string;
  avatarUrl?: string;
};
export type GithubWorkItem = {
  kind: GithubTaskKind;
  number: number;
  title: string;
  url: string;
  state: string;
  /** GitHub issue closure reason, such as `completed` or `not_planned`. */
  stateReason?: string;
  createdAt?: string;
  updatedAt: string;
  labels: GithubLabel[];
  assignees: GithubAssignee[];
  draft: boolean;
  repo: string;
};
export type GithubWorkItemDetails = {
  body: string;
  author: string;
  authorAvatarUrl?: string;
  baseRefName?: string;
  headRefName?: string;
  reviewDecision?: string;
};
export type GithubStarStatus = "starred" | "notStarred" | "unavailable";
const repoByPath = new Map<string, string>();
const repositoriesByPath = new Map<string, string[]>();
const workItemByKey = new Map<string, GithubWorkItem>();
const workItemInflight = new Map<string, Promise<GithubWorkItem>>();
const detailsByKey = new Map<string, GithubWorkItemDetails>();
const detailsInflight = new Map<string, Promise<GithubWorkItemDetails>>();
/** When each details, thread and diff entry last arrived, by cache map key. */
const fetchedAt = new Map<string, number>();
function freshEnough(key: string, maxAgeMs: number | undefined): boolean {
  if (maxAgeMs == null) return false;
  const at = fetchedAt.get(key);
  return at != null && Date.now() - at < maxAgeMs;
}
/** Whether the active GitHub CLI account has starred Handwork. */
export function githubHandworkStarStatus(): Promise<GithubStarStatus> {
  return invoke<GithubStarStatus>("github_handwork_star_status");
}
/** Star Handwork for the active GitHub CLI account. */
export function starHandworkOnGithub(): Promise<void> {
  return invoke<void>("github_star_handwork");
}
export async function githubRepo(cwd: string): Promise<string> {
  const key = normalizeProjectPath(cwd);
  const cached = repoByPath.get(key);
  if (cached !== undefined) return cached;
  const repositories = repositoriesByPath.get(key);
  if (repositories?.[0]) return repositories[0];
  const repo = await invoke<string>("git_github_repo", { cwd });
  repoByPath.set(key, repo);
  return repo;
}
function workItemLookupKey(
  repo: string,
  kind: GithubTaskKind,
  number: number,
): string {
  return `${repo.trim().toLowerCase()}:${kind}:${number}`;
}
export function peekGithubWorkItem(
  repo: string,
  kind: GithubTaskKind,
  number: number,
): GithubWorkItem | null {
  return workItemByKey.get(workItemLookupKey(repo, kind, number)) ?? null;
}
/** Fetch one exact item after targeted Inbox navigation misses its list cache. */
export function githubWorkItem(
  cwd: string,
  repo: string,
  kind: GithubTaskKind,
  number: number,
  options?: {
    force?: boolean;
  },
): Promise<GithubWorkItem> {
  const key = workItemLookupKey(repo, kind, number);
  const cached = workItemByKey.get(key);
  if (cached && !options?.force) return Promise.resolve(cached);
  const pending = workItemInflight.get(key);
  if (pending) return pending;
  const promise = invoke<GithubWorkItem>("git_github_work_item", {
    cwd,
    repo,
    kind,
    number,
  })
    .then((item) => {
      workItemByKey.set(key, item);
      return item;
    })
    .finally(() => {
      if (workItemInflight.get(key) === promise) workItemInflight.delete(key);
    });
  workItemInflight.set(key, promise);
  return promise;
}
export function formatRelativeTime(
  iso: string,
  now = Date.now(),
  locale?: string,
): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const delta = Math.round((then - now) / 1000);
  const abs = Math.abs(delta);
  const divisions: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.34524, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = delta;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  let amount = abs;
  for (const [step, next] of divisions) {
    unit = next;
    if (amount < step) break;
    value = Math.round(value / step);
    amount = Math.abs(value);
  }
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
      value,
      unit,
    );
  } catch {
    return "";
  }
}
export function detailsCacheKey(
  repo: string,
  kind: GithubTaskKind,
  number: number,
): string {
  return workItemLookupKey(repo, kind, number);
}
export function peekGithubWorkItemDetails(
  repo: string,
  kind: GithubTaskKind,
  number: number,
): GithubWorkItemDetails | null {
  return detailsByKey.get(detailsCacheKey(repo, kind, number)) ?? null;
}
export async function githubWorkItemDetails(
  cwd: string,
  repo: string,
  kind: GithubTaskKind,
  number: number,
  options?: {
    maxAgeMs?: number;
  },
): Promise<GithubWorkItemDetails> {
  const key = detailsCacheKey(repo, kind, number);
  const cached = detailsByKey.get(key);
  if (cached && freshEnough(`details:${key}`, options?.maxAgeMs)) {
    return cached;
  }
  const pending = detailsInflight.get(key);
  if (pending) return pending;
  const promise = invoke<GithubWorkItemDetails>(
    "git_github_work_item_details",
    { cwd, repo, kind, number },
  )
    .then((details) => {
      detailsByKey.set(key, details);
      fetchedAt.set(`details:${key}`, Date.now());
      return details;
    })
    .finally(() => {
      if (detailsInflight.get(key) === promise) detailsInflight.delete(key);
    });
  detailsInflight.set(key, promise);
  return promise;
}
