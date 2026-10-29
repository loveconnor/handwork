"use client";

import type { ComponentType } from "react";
import { Anthropic, Deepseek, GoogleGemini, OpenAI, XAIGrok } from "honestui/logos";
import { siMinimax, siMistralai, siOllama, siOpenrouter, siQwen } from "simple-icons";
import { Monogram } from "@/components/atoms/EntityChip";

/* Provider marks for the model picker. honestui/logos covers the major labs;
 * the rest come from simple-icons paths, and anything unknown gets a monogram
 * so a new engine provider never renders as a blank. */

type LogoComponent = ComponentType<{ size?: number | string; className?: string; "aria-hidden"?: boolean | "true" }>;
/* `mono` marks come with no fill of their own (Anthropic) or currentColor, so
 * they take the surrounding text color; Gemini and DeepSeek keep brand color. */
const HONEST: Record<string, { Logo: LogoComponent; mono: boolean }> = {
  codex: { Logo: OpenAI, mono: true }, openai: { Logo: OpenAI, mono: true }, anthropic: { Logo: Anthropic, mono: true },
  gemini: { Logo: GoogleGemini, mono: false }, xai: { Logo: XAIGrok, mono: true }, grok: { Logo: XAIGrok, mono: true }, deepseek: { Logo: Deepseek, mono: false },
};
const SIMPLE: Record<string, { path: string; title: string }> = {
  mistral: siMistralai, ollama: siOllama, ollama_cloud: siOllama, openrouter: siOpenrouter, minimax: siMinimax, qwen: siQwen,
};
const MONOGRAM_COLORS: Record<string, string> = { groq: "#f55036", together: "#3b82f6", fireworks: "#7c3aed" };

export function ProviderLogo({ provider, name, size = 16, className = "" }: { provider: string; name?: string; size?: number; className?: string }) {
  const key = provider.toLowerCase();
  const honest = HONEST[key];
  if (honest) return <span className={`inline-flex shrink-0 items-center justify-center ${honest.mono ? "[&_path]:fill-current" : ""} ${className}`} style={{ width: size, height: size }}><honest.Logo size={size} aria-hidden="true" /></span>;
  const simple = SIMPLE[key];
  if (simple) return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={`shrink-0 ${className}`} aria-hidden="true"><path d={simple.path} /></svg>;
  const initial = (name || provider).trim().charAt(0).toUpperCase() || "?";
  return <Monogram color={MONOGRAM_COLORS[key] ?? "#6b7280"} className={className} >{initial}</Monogram>;
}
