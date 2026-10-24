import type { BuiltinSkill } from "../../skills/model/skills";
export const MCP_COMMAND: BuiltinSkill = {
  kind: "builtin",
  name: "mcp",
  invocation: "mcp",
  description: "Choose an MCP tool server for this message.",
  scope: "builtin",
  source: "handwork",
};
export function isMcpCommand(text: string): boolean {
  return /^\s*\/mcp\s*$/i.test(text);
}
