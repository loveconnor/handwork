// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHomeDir, setHomeDir } from "../../../shared/lib/paths";
import { newSession } from "../../sessions/model/session";
import {
  mobileCatalog,
  mobileModels,
  mobileProjectId,
} from "./mobileWorkspace";

const saved = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../../integrations/harness", () => ({}));
vi.mock("../../source-control/ui/GitChangesPanel", () => ({}));
vi.mock("./mobileHighlight", () => ({}));
vi.mock("../../projects/model/recents", async (original) => ({
  ...(await original<typeof import("../../projects/model/recents")>()),
  loadRecents: () => [{ path: "/repo" }],
  loadPinnedProjects: () => [],
}));
vi.mock("../../monos/model/mono", () => ({ listMonos: () => [] }));
vi.mock("../../sessions/data/sessionStore", () => ({
  listSessionsByProject: saved.list,
}));
const home = getHomeDir();
beforeEach(() => {
  localStorage.clear();
  setHomeDir("/home/me");
  saved.list.mockReset().mockResolvedValue([]);
});
afterEach(() => setHomeDir(home));

describe("mobile normal chats", () => {
  it("publishes Chats without adding the home folder to recent projects", async () => {
    const catalog = await mobileCatalog([]);
    expect(
      catalog.projects.map(({ name, path, kind }) => ({ name, path, kind })),
    ).toEqual([
      { name: "Chats", path: "/home/me", kind: "chats" },
      { name: "repo", path: "/repo", kind: undefined },
    ]);
    expect(saved.list).toHaveBeenCalledWith("/home/me");
  });
  it("includes saved and live chat history with the same routing ID", async () => {
    saved.list.mockImplementation(async (cwd: string) =>
      cwd === "/home/me"
        ? [
            {
              id: "saved",
              cwd,
              title: "Earlier chat",
              harness: "handwork",
              model: "",
              updatedAt: 1,
            },
            { id: "archived", cwd, archived: true },
          ]
        : [],
    );
    const live = {
      ...newSession("handwork", "/home/me"),
      title: "Live chat",
      busy: true,
    };
    const catalog = await mobileCatalog([live]);
    expect(catalog.sessions.map((session) => session.id).sort()).toEqual(
      ["saved", live.id].sort(),
    );
    expect(
      catalog.sessions.every(
        (session) => session.projectId === mobileProjectId("/home/me"),
      ),
    ).toBe(true);
  });
  it("opens the model picker for Chats without a recent home project", async () => {
    const models = await mobileModels(
      { projectId: mobileProjectId("/home/me") },
      [],
    );
    expect(models.current.harness).toBeDefined();
    await expect(mobileModels({ projectId: "missing" }, [])).rejects.toThrow(
      "no longer available",
    );
  });
});
