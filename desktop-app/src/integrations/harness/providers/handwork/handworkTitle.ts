import {
  buildThreadTitlePrompt,
  parseGeneratedSessionTitle,
  type GeneratedSessionTitle,
} from "../../../../features/sessions/model/sessionTitle";
import { runHandworkTextPrompt } from "./handworkText";
const TITLE_TIMEOUT_MS = 45000;
/** Handwork app-server turn that returns a sidebar title, or null on failure. */
export async function generateHandworkSessionTitle(input: {
  sessionId: string;
  cwd: string;
  message: string;
  providerAccountId?: string;
}): Promise<GeneratedSessionTitle | null> {
  try {
    const output = await runHandworkTextPrompt({
      cwd: input.cwd,
      providerAccountId: input.providerAccountId,
      prompt: buildThreadTitlePrompt(input.message),
      timeoutMs: TITLE_TIMEOUT_MS,
    });
    return parseGeneratedSessionTitle(output, input.message);
  } catch (error) {
    console.debug("[handwork] session title", error);
    return null;
  }
}
