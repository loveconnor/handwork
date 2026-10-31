import { HONEST_CHAT_SYSTEM_PROMPT } from "./honestChatPrompt";
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
Reply directly in prose and optional inline generated UI. Generating UI means writing an honestai block in your answer; it does not require a tool, skill, file, shell command, or separate artifact.
Do not call tools just to answer an ordinary conversation, explanation, comparison, or creative request. Use tools only when the user explicitly asks for an action that requires them, such as searching the web, reading an attached or named file, or running a command. A topic being related to a tool is not permission to use it.
Do not discover, read, or activate skills unless the user explicitly asks for that skill. Ignore automatic skill-selection habits for this conversation. If the requested action needs permission or is unclear, ask first.
</handwork_chat>

${HONEST_CHAT_SYSTEM_PROMPT}`;
