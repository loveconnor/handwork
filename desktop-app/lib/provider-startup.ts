import { configOptions, providerList, type ConfigOption, type ProviderInfo } from './desktop-state';

const providerKey = 'handwork.providers.v1';
const optionsKey = 'handwork.providerOptions.v1';
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
function storage(): Storage | undefined { try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; } }

// Display snapshots only. The engine still validates credentials and selections.
export function cachedProviders(store = storage()): ProviderInfo[] {
  try { return providerList({ providers: JSON.parse(store?.getItem(providerKey) || '[]') }); } catch { return []; }
}
export function cacheProviders(providers: ProviderInfo[], store = storage()) {
  try { store?.setItem(providerKey, JSON.stringify(providers.map(({ id, name, connected, signIn }) => ({ id, name, connected, signIn })))); } catch { /* Optional startup cache. */ }
}
export function cachedProviderOptions(store = storage()): ConfigOption[] {
  try { return configOptions(JSON.parse(store?.getItem(optionsKey) || '[]')); } catch { return []; }
}
export function cacheProviderOptions(options: ConfigOption[], store = storage()) {
  try { store?.setItem(optionsKey, JSON.stringify(options)); } catch { /* Optional startup cache. */ }
}
export function visibleProviderOptions(options: ConfigOption[], providers: ProviderInfo[]): ConfigOption[] {
  return options.map(option => {
    if (option.id !== 'provider') return option;
    const available = new Map(option.options.filter(choice => choice.value === option.currentValue || providers.some(provider => provider.id === choice.value && provider.connected)).map(choice => [choice.value, choice]));
    for (const provider of providers) if (provider.connected && !available.has(provider.id)) available.set(provider.id, { value: provider.id, name: provider.name });
    return { ...option, options: [...available.values()] };
  });
}
