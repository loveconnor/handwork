import type { ModelPreferences, ModelReference, ModelUsage } from './desktop-api';
import type { ConfigOption } from './desktop-state';

export const modelKey = (provider: string, model: string) => `${provider}\n${model}`;

const DAY = 24 * 60 * 60 * 1000;
/** Uses count less as they age: a use two weeks ago counts half as much as one today. */
export function frecency(usage: Pick<ModelUsage, 'count' | 'lastUsed'>, now = Date.now()): number {
  const age = Math.max(0, now - usage.lastUsed) / DAY;
  return usage.count * 0.5 ** (age / 14);
}

export type ModelShortcut = ModelReference & { key: string; current: boolean };

/**
 * Favorites, then frequently used models, that can be chosen from the current
 * provider list. A model on the current provider must still be offered by it.
 */
export function modelShortcuts(preferences: ModelPreferences | undefined, options: ConfigOption[], { limit = 3, now = Date.now() } = {}) {
  const provider = options.find(option => option.id === 'provider');
  const model = options.find(option => option.id === 'model');
  const empty = { favorites: [] as ModelShortcut[], frequent: [] as ModelShortcut[], favorite: false };
  if (!preferences || !model) return empty;
  const currentProvider = provider?.currentValue ?? '';
  const currentKey = modelKey(currentProvider, model.currentValue);
  const available = (item: ModelReference) => item.provider === currentProvider
    ? model.options.some(choice => choice.value === item.model)
    : !!provider?.options.some(choice => choice.value === item.provider);
  const shortcut = (item: ModelReference): ModelShortcut => {
    const key = modelKey(item.provider, item.model);
    const name = item.provider === currentProvider ? model.options.find(choice => choice.value === item.model)?.name ?? item.name : item.name;
    return { provider: item.provider, model: item.model, name, key, current: key === currentKey };
  };
  const favorites = preferences.favorites.filter(available).map(shortcut);
  const favored = new Set(favorites.map(item => item.key));
  const frequent = preferences.usage
    .filter(item => available(item) && !favored.has(modelKey(item.provider, item.model)) && modelKey(item.provider, item.model) !== currentKey)
    .map(item => ({ item, score: frecency(item, now) }))
    .filter(entry => entry.score >= 0.25)
    .sort((a, b) => b.score - a.score || b.item.lastUsed - a.item.lastUsed)
    .slice(0, limit)
    .map(entry => shortcut(entry.item));
  return { favorites, frequent, favorite: preferences.favorites.some(item => modelKey(item.provider, item.model) === currentKey) };
}
