// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import {
  knownNotificationProject,
  knownNotificationProjectSelection,
  loadNotificationProjects,
  rememberNotificationProjects,
} from "./notificationProjects";

beforeEach(() => localStorage.clear());

it("derives local notification identity immediately from the normalized path", () => {
  expect(knownNotificationProject("C:/Work/App")).toEqual({
    id: "local:c:/work/app",
    name: "App",
    detail: "C:/Work/App",
    kind: "local",
    paths: ["C:/Work/App"],
  });
  expect(knownNotificationProject("c:\\work\\app")?.id).toBe(
    "local:c:/work/app",
  );
});

it("keeps separate checkout and worktree paths as separate projects", () => {
  const selection = knownNotificationProjectSelection([
    "/work/app",
    "/work/app-review",
  ]);
  expect(selection.projects.map((project) => project.id)).toEqual([
    "local:/work/app",
    "local:/work/app-review",
  ]);
});

it("uses a new catalog version so old Git-derived path mappings are ignored", () => {
  localStorage.setItem(
    "handwork.notificationProjects.v1",
    JSON.stringify([
      {
        id: "repository:github.com/old/app",
        name: "old/app",
        detail: "github.com",
        kind: "repository",
        paths: ["/work/app"],
      },
    ]),
  );
  expect(loadNotificationProjects()).toEqual([]);
  expect(knownNotificationProject("/work/app")?.id).toBe("local:/work/app");
});
