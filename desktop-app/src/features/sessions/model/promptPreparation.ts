import { isNormalChat, NORMAL_CHAT_CONTEXT } from "./normalChats";
import { applyFileMentionsToTurn } from "../../files/model/fileMentions";
import {
  applySkillsToTurn,
  warmNativeSkills,
  isNativeCommandPrompt,
  type SkillCatalogContext,
  skillNamesInText,
} from "../../skills/model/skills";
import { nativeCommandPrompt } from "../../../integrations/harness/core/nativeCommands";
export async function preparePrompt(
  text: string,
  context: SkillCatalogContext,
): Promise<string> {
  // A normal chat should not discover provider skills just by sending prose.
  if (!isNormalChat(context.cwd) || skillNamesInText(text).length > 0)
    warmNativeSkills(context);
  if (isNativeCommandPrompt(text, context.harness))
    return nativeCommandPrompt(context.harness, text);
  const withFiles = await applyFileMentionsToTurn(text, context.cwd);
  const prompt = await applySkillsToTurn(withFiles, context);
  return isNormalChat(context.cwd)
    ? `${NORMAL_CHAT_CONTEXT}\n\n${prompt}`
    : prompt;
}
