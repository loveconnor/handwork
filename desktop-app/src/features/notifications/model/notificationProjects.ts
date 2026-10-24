import { pathKey, projectName } from "../../../shared/lib/paths";
import { looksLikeProject } from "../../projects/model/recents";
export type NotificationProject = {
  id: string;
  name: string;
  detail: string;
  kind: "repository" | "local";
  paths: string[];
};
const CATALOG_KEY = "handwork.notificationProjects.v2";
const CATALOG_CHANGE = "handwork:notification-projects-change";
let catalogValue: string | null | undefined;
let catalog: NotificationProject[] = [];
function localNotificationProject(path: string): NotificationProject {
  return {
    id: `local:${pathKey(path)}`,
    name: projectName(path),
    detail: path,
    kind: "local",
    paths: [path],
  };
}
export function knownNotificationProject(
  path: string,
): NotificationProject | undefined {
  if (!looksLikeProject(path)) return;
  const key = pathKey(path);
  return (
    loadNotificationProjects().find((project) =>
      project.paths.some((entry) => pathKey(entry) === key),
    ) ?? localNotificationProject(path)
  );
}
export function knownNotificationProjectSelection(paths: readonly string[]): {
  projects: NotificationProject[];
} {
  const requested = new Map(
    paths.filter(looksLikeProject).map((path) => [pathKey(path), path]),
  );
  const stored = loadNotificationProjects();
  const projects = new Map(
    stored
      .filter(
        (project) =>
          project.paths.length === 0 ||
          project.paths.some((path) => requested.has(pathKey(path))),
      )
      .map((project) => [project.id, project]),
  );
  for (const path of requested.values()) {
    const project = knownNotificationProject(path)!;
    projects.set(project.id, project);
  }
  return { projects: [...projects.values()] };
}
export function loadNotificationProjects(): NotificationProject[] {
  try {
    const value = localStorage.getItem(CATALOG_KEY);
    if (value === catalogValue) return catalog;
    catalogValue = value;
    catalog = [];
    const parsed: unknown = JSON.parse(value ?? "[]");
    if (!Array.isArray(parsed)) return catalog;
    catalog = parsed.filter(
      (value): value is NotificationProject =>
        value &&
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        typeof value.detail === "string" &&
        ["repository", "local"].includes(value.kind) &&
        Array.isArray(value.paths) &&
        value.paths.every((path: unknown) => typeof path === "string"),
    );
    return catalog;
  } catch {
    return catalog;
  }
}
export function rememberNotificationProjects(
  projects: readonly NotificationProject[],
) {
  const current = loadNotificationProjects();
  const byId = new Map(current.map((project) => [project.id, project]));
  for (const project of projects) {
    const previous = byId.get(project.id);
    byId.set(project.id, {
      ...project,
      paths: [...new Set([...(previous?.paths ?? []), ...project.paths])],
    });
  }
  const nextProjects = [...byId.values()];
  const next = JSON.stringify(nextProjects);
  if (next === JSON.stringify(current)) return;
  catalog = nextProjects;
  try {
    localStorage.setItem(CATALOG_KEY, next);
    catalogValue = next;
  } catch {
    // Keep the catalog in memory when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(CATALOG_CHANGE));
}
export function notificationProjectsSnapshot(): string {
  return JSON.stringify(loadNotificationProjects());
}
export function subscribeNotificationProjects(
  listener: () => void,
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === CATALOG_KEY || event.key === null) listener();
  };
  window.addEventListener(CATALOG_CHANGE, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CATALOG_CHANGE, listener);
    window.removeEventListener("storage", onStorage);
  };
}
