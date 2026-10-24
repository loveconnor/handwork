import { ClaudeAI, OpenAI, Cursor, Grok } from "honestui/logos";
import {
  AppWindow,
  Terminal,
  type IconComponent,
} from "../../../shared/ui/icons";
import {
  ProviderBrandLogo,
  providerBrand,
  type ProviderBrand,
} from "./ProviderBrandLogo";
import type { HarnessId } from "../model/session";

// Use HonestUI brand marks first, LobeHub for additional provider logos, and
// neutral HonestUI icons for providers that neither catalog identifies.
const MARKS = { claude: ClaudeAI, codex: OpenAI, cursor: Cursor, grok: Grok };
const EXTERNAL_MARKS: Partial<Record<HarnessId, ProviderBrand>> = {
  opencode: "opencode",
  hermes: "hermes",
  antigravity: "antigravity",
  devin: "devin",
  pi: "pi",
  omp: "omp",
  fx: "fx",
};
const FALLBACKS: Partial<Record<HarnessId, IconComponent>> = {
  handwork: AppWindow,
};
export function HarnessIcon({
  harness,
  provider,
  className = "size-3.5",
}: {
  harness: HarnessId;
  provider?: string;
  className?: string;
}) {
  const external = providerBrand(provider) ?? EXTERNAL_MARKS[harness];
  if (external)
    return <ProviderBrandLogo provider={external} className={className} />;
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
