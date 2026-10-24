import { afterEach, describe, expect, it } from "vitest";
import { getHomeDir, setHomeDir } from "../../../shared/lib/paths";
import { looksLikeProject } from "../../projects/model/recents";
import { planProjectReturn } from "../../projects/model/projectReturn";
import { newTab } from "../../workspace/model/layout";
import { filterTabsForProject } from "../../workspace/model/workspaceTabGroups";
import { newSession } from "./session";
import { isNormalChat, newNormalChat, normalChatCwd } from "./normalChats";
import {
  shouldPersistSession,
  sanitizeSessionForPersist,
} from "../data/sessionStore";
const originalHome = getHomeDir();
afterEach(() => setHomeDir(originalHome));
describe("standalone chats", () => {
  it.each(["/Users/me", "/home/me", "/custom/home", "C:/Users/Me"])(
    "creates an ordinary persistent chat outside projects at %s",
    (home) => {
      setHomeDir(home);
      const chat = newNormalChat();
      expect(normalChatCwd()).toBe(home);
      expect(chat.cwd).toBe(home);
      expect(chat.title).toBe("New chat");
      expect(chat.worktreeCwd).toBeUndefined();
      expect(isNormalChat(home + "/")).toBe(true);
      expect(looksLikeProject(home)).toBe(false);
      expect(isNormalChat(home + "/project")).toBe(false);
      const conversation = {
        ...chat,
        blocks: [{ id: "u", role: "user" as const, text: "Explain eclipses" }],
      };
      expect(shouldPersistSession(conversation)).toBe(true);
      expect(sanitizeSessionForPersist(conversation)).toMatchObject({
        cwd: home,
        title: "New chat",
        blocks: conversation.blocks,
      });
    },
  );
  it("keeps chats intact when opening a project and groups their tabs separately", () => {
    setHomeDir("/custom/home");
    const chat = newNormalChat();
    const project = newSession("handwork", "/repo");
    const tabs = [newTab(chat.id), newTab(project.id)];
    const sessions = [chat, project];
    expect(filterTabsForProject(tabs, sessions, chat.cwd)).toEqual([tabs[0]]);
    expect(
      planProjectReturn({
        sessions,
        tabs,
        activeTabId: tabs[0].id,
        memory: new Map(),
        projectPath: "/another",
      }),
    ).toMatchObject({ action: "create" });
    expect(chat.cwd).toBe("/custom/home");
  });
});
