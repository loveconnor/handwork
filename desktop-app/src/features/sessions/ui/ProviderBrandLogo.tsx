import openCodeMark from "@lobehub/icons-static-svg/icons/opencode.svg?raw";
import antigravityMark from "@lobehub/icons-static-svg/icons/antigravity.svg?raw";
import devinMark from "@lobehub/icons-static-svg/icons/devin.svg?raw";
import hermesMark from "@lobehub/icons-static-svg/icons/hermesagent.svg?raw";
import ollamaMark from "@lobehub/icons-static-svg/icons/ollama.svg?raw";

import anthropicMark from "@lobehub/icons-static-svg/icons/anthropic.svg?raw";
import openaiMark from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import deepseekMark from "@lobehub/icons-static-svg/icons/deepseek.svg?raw";
import githubcopilotMark from "@lobehub/icons-static-svg/icons/githubcopilot.svg?raw";
import geminiMark from "@lobehub/icons-static-svg/icons/gemini.svg?raw";
import geminicliMark from "@lobehub/icons-static-svg/icons/geminicli.svg?raw";
import lmstudioMark from "@lobehub/icons-static-svg/icons/lmstudio.svg?raw";
import openrouterMark from "@lobehub/icons-static-svg/icons/openrouter.svg?raw";
import xaiMark from "@lobehub/icons-static-svg/icons/xai.svg?raw";
import mistralMark from "@lobehub/icons-static-svg/icons/mistral.svg?raw";
import qwenMark from "@lobehub/icons-static-svg/icons/qwen.svg?raw";
import minimaxMark from "@lobehub/icons-static-svg/icons/minimax.svg?raw";
import moonshotMark from "@lobehub/icons-static-svg/icons/moonshot.svg?raw";
import kimiMark from "@lobehub/icons-static-svg/icons/kimi.svg?raw";
import zaiMark from "@lobehub/icons-static-svg/icons/zai.svg?raw";
import zhipuMark from "@lobehub/icons-static-svg/icons/zhipu.svg?raw";
import groqMark from "@lobehub/icons-static-svg/icons/groq.svg?raw";
import togetherMark from "@lobehub/icons-static-svg/icons/together.svg?raw";
import cerebrasMark from "@lobehub/icons-static-svg/icons/cerebras.svg?raw";
import perplexityMark from "@lobehub/icons-static-svg/icons/perplexity.svg?raw";
import huggingfaceMark from "@lobehub/icons-static-svg/icons/huggingface.svg?raw";
import piMark from "../../../shared/assets/brands/pi.svg?raw";
import ompMark from "../../../shared/assets/brands/omp.svg?raw";
import fxMark from "../../../shared/assets/brands/fx.svg?raw";

/** LobeHub supplies brands not yet included in honestui/logos. */
const marks = {
  opencode: openCodeMark,
  ollama: ollamaMark,
  antigravity: antigravityMark,
  devin: devinMark,
  hermes: hermesMark,
  anthropic: anthropicMark,
  openai: openaiMark,
  deepseek: deepseekMark,
  githubcopilot: githubcopilotMark,
  gemini: geminiMark,
  geminicli: geminicliMark,
  lmstudio: lmstudioMark,
  openrouter: openrouterMark,
  xai: xaiMark,
  mistral: mistralMark,
  qwen: qwenMark,
  minimax: minimaxMark,
  moonshot: moonshotMark,
  kimi: kimiMark,
  zai: zaiMark,
  zhipu: zhipuMark,
  groq: groqMark,
  together: togetherMark,
  cerebras: cerebrasMark,
  perplexity: perplexityMark,
  huggingface: huggingfaceMark,
  pi: piMark,
  omp: ompMark,
  fx: fxMark,
};
// Render bundled, trusted SVG markup directly. CSS URL masks can become solid
// squares in desktop WebKit; inline SVG also inherits the surrounding text color.
const inlineMarks = Object.fromEntries(
  Object.entries(marks).map(([brand, svg]) => [
    brand,
    svg.replace(/<svg\b[^>]*>/, (tag) =>
      tag
        .replace(/\s(?:width|height|style)="[^"]*"/g, "")
        .replace(
          "<svg",
          '<svg width="100%" height="100%" style="display:block"',
        ),
    ),
  ]),
);
const aliases: Record<string, ProviderBrand> = {
  "github-copilot": "githubcopilot",
  "google-antigravity": "antigravity",
  "google-gemini-cli": "geminicli",
  google: "gemini",
  "lm-studio": "lmstudio",
  "openai-codex": "openai",
  "ollama-cloud": "ollama",
  "opencode-go": "opencode",
  "opencode-zen": "opencode",
  "z-ai": "zai",
};
export function providerBrand(provider?: string): ProviderBrand | undefined {
  const id = provider?.toLowerCase().replace(/_/g, "-");
  if (!id) return undefined;
  return (
    (Object.prototype.hasOwnProperty.call(aliases, id)
      ? aliases[id]
      : undefined) ??
    (Object.prototype.hasOwnProperty.call(marks, id)
      ? (id as ProviderBrand)
      : undefined)
  );
}
export type ProviderBrand = keyof typeof marks;
export function ProviderBrandLogo({
  provider,
  className = "size-4",
}: {
  provider: ProviderBrand;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-provider-logo={provider}
      className={`block shrink-0 ${className}`}
      dangerouslySetInnerHTML={{ __html: inlineMarks[provider] }}
    />
  );
}
