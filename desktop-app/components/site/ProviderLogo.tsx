"use client";
import { OpenAI, Anthropic, ClaudeAI, Deepseek, Grok, Github } from 'honestui/logos';
import { Cpu } from 'honestui/icons';
import { siMistralai, siOllama, siGooglegemini, siMinimax, siOpencode, siOpenrouter, siQwen } from 'simple-icons';

// Honest UI brand components where available. Remaining brand paths come from
// the installed Simple Icons CC0 asset catalog; no external image requests.
export function ProviderLogo({ provider, size = 18 }: { provider: string; size?: number }) {
  const logos: Record<string, typeof OpenAI> = { claude: ClaudeAI, anthropic: Anthropic, codex: OpenAI, openai: OpenAI, deepseek: Deepseek, grok: Grok, xai: Grok, copilot: Github, github_copilot: Github };
  const assets: Record<string, typeof siOllama> = { mistral: siMistralai, ollama: siOllama, ollama_cloud: siOllama, google: siGooglegemini, gemini: siGooglegemini, minimax: siMinimax, opencode: siOpencode, openrouter: siOpenrouter, qwen: siQwen };
  const Logo = Object.hasOwn(logos, provider) ? logos[provider] : undefined;
  const asset = Object.hasOwn(assets, provider) ? assets[provider] : undefined;
  return <span className="handwork-provider-logo" data-provider={provider} data-brand={Logo || asset ? '' : undefined} aria-hidden="true">
    {Logo ? <Logo size={size} aria-hidden="true" focusable="false" /> : asset ? <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d={asset.path} /></svg> : <Cpu size={size} aria-hidden="true" />}
  </span>;
}
