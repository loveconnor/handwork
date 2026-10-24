import { getHomeDir, prettyCwd, pathKey } from "../../../shared/lib/paths";
import { newDefaultSession, type Session } from "./session";

/** Ordinary conversations share a history outside the user's project folders. */
export function normalChatCwd(): string {
  return getHomeDir() ?? "~";
}
export function isNormalChat(cwd: string): boolean {
  const home = getHomeDir();
  return (
    cwd === "~" ||
    prettyCwd(cwd) === "~" ||
    !!(home && pathKey(cwd) === pathKey(home))
  );
}
export function newNormalChat(cwd = normalChatCwd()): Session {
  return { ...newDefaultSession(cwd), title: "New chat" };
}
export const NORMAL_CHAT_CONTEXT = `<handwork_chat>
This is a standalone, general-purpose conversation. No project or repository is attached.
Answer the user's request naturally; do not assume it is a coding task or start inspecting the working directory.
Use files the user attaches or explicitly asks you to access. Do not infer a project from the process working directory.
</handwork_chat>`;
