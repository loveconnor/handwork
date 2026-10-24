import { ClaudeAI, OpenAI, Cursor, Grok } from "honestui/logos";
import {
  AppWindow,
  Code,
  Sparkles,
  Terminal,
  type IconComponent,
} from "../../../shared/ui/icons";
import type { HarnessId } from "../model/session";

// Use Honest UI brand marks where supplied. Neutral Honest UI icons represent
// providers without a mark in the catalog, rather than unrelated brand artwork.
const MARKS = { claude: ClaudeAI, codex: OpenAI, cursor: Cursor, grok: Grok };
const FALLBACKS: Partial<Record<HarnessId, IconComponent>> = {
  handwork: AppWindow,
  opencode: Code,
  pi: Terminal,
  omp: Terminal,
  fx: Code,
  hermes: Terminal,
  antigravity: Sparkles,
  devin: Terminal,
};
export function HarnessIcon({
  harness,
  className = "size-3.5",
}: {
  harness: HarnessId;
  className?: string;
}) {
  const Logo = MARKS[harness as keyof typeof MARKS];
  if (Logo)
    return (
      <Logo
        aria-hidden="true"
        data-honest-logo={harness}
        className={`block shrink-0 ${className}`}
      />
    );
  const Icon = FALLBACKS[harness] ?? Terminal;
  return <Icon className={`block shrink-0 ${className}`} />;
}
