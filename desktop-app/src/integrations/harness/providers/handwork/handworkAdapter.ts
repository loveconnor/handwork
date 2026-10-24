import { runHandworkTextPrompt, stopHandworkTextPrompt } from "./handworkText";
import { generateHandworkSessionTitle } from "./handworkTitle";
import {
  generateHandworkCommitMessage,
  generateHandworkPrContent,
  generateHandworkBranchName,
} from "./handworkGit";
import {
  bindHandworkSession,
  cancelHandworkTurn,
  forgetHandworkSession,
  respondHandworkApproval,
  sendHandworkTurn,
  steerHandworkTurn,
  stopHandworkSession,
} from "./handwork";
import { refreshHandworkCatalog } from "./handworkCatalog";
import { registerHarness, type HarnessAdapter } from "../../core/registry";
export const handworkAdapter: HarnessAdapter = {
  id: "handwork",
  live: true,
  runTextPrompt: runHandworkTextPrompt,
  stopTextPrompt: stopHandworkTextPrompt,
  generateTitle: generateHandworkSessionTitle,
  generateCommitMessage: generateHandworkCommitMessage,
  generatePrContent: generateHandworkPrContent,
  generateBranchName: generateHandworkBranchName,
  canSteer: false,
  sendTurn: sendHandworkTurn,
  steerTurn: steerHandworkTurn,
  cancelTurn: cancelHandworkTurn,
  respondApproval: respondHandworkApproval,
  stopSession: stopHandworkSession,
  forgetSession: forgetHandworkSession,
  bindSession: bindHandworkSession,
  refreshCatalog: refreshHandworkCatalog,
};
let registered = false;
export function ensureHandworkRegistered(): void {
  if (registered) return;
  registerHarness(handworkAdapter);
  registered = true;
}
