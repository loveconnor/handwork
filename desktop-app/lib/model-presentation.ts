// Reviewed against provider documentation on 2026-10-14. These are task profiles,
// not benchmarks or subscription prices. Match exact IDs; unknown models stay neutral.
// https://developers.openai.com/api/docs/guides/latest-model
// https://developers.openai.com/api/docs/models/gpt-5.6-terra
export type ModelProfile = 'frontier' | 'balanced' | 'efficient' | 'advanced';
export const modelProfiles: Record<ModelProfile, { label: string; detail: string }> = {
  frontier: { label: 'Frontier', detail: 'Demanding reasoning and coding' },
  balanced: { label: 'Balanced', detail: 'Capability with efficiency' },
  efficient: { label: 'Efficient', detail: 'Lightweight, high-volume work' },
  advanced: { label: 'Advanced', detail: 'Complex coding and reasoning' },
};
const knownProfiles: Record<string, ModelProfile> = {
  'gpt-6-astra': 'frontier', 'gpt-6.1-sol': 'balanced', 'gpt-6-sol': 'balanced',
  'gpt-6-luna': 'efficient', 'gpt-5.6-sol': 'advanced',
  'gpt-5.6-terra': 'balanced', 'gpt-5.6-luna': 'efficient',
};
export function modelProfile(provider: string, id: string): ModelProfile | undefined {
  if (provider !== 'codex' && provider !== 'openai') return undefined;
  return Object.hasOwn(knownProfiles, id) ? knownProfiles[id] : undefined;
}

/** Presentation only: the engine still receives the original IDs and values. */
export function modelDisplayName(name: string): string {
  return name.replace(/[-_]+/g, ' ').replace(/\b[a-z][a-z\d]*/gi, word => {
    if (['gpt', 'api'].includes(word.toLowerCase())) return word.toUpperCase();
    return word[0].toUpperCase() + word.slice(1);
  });
}

export function settingDisplayName(name: string): string {
  const label = name === 'xhigh' ? 'Extra high' : name.replace(/[-_]+/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}
