import type { BuiltinSkill } from "../../skills/model/skills";
export const ORCHESTRATOR_COMMAND: BuiltinSkill = {
  kind: "builtin",
  name: "orchestrator",
  invocation: "orchestrator",
  description: "Assign tasks to agents and coordinate their work.",
  scope: "builtin",
  source: "handwork",
};
/** Consume `/orchestrator` when it is used as the leading composer command. */
export function consumeOrchestratorCommand(text: string): {
  text: string;
  matched: boolean;
} {
  const match = text.match(/^\s*\/orchestrator(?=\s|$)\s*/i);
  if (!match) return { text, matched: false };
  return { text: text.slice(match[0].length), matched: true };
}
