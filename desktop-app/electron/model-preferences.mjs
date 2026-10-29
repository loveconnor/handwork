import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const MAX_USAGE = 50;
const MAX_FAVORITES = 30;
const key = item => `${item.provider}\n${item.model}`;
const reference = value => value && typeof value === 'object' && typeof value.provider === 'string' && typeof value.model === 'string' && typeof value.name === 'string';

/** Favorite models and how often each model is used to send. Never stores prompts. */
export class ModelPreferences {
  constructor(file) { this.file = file; this.memory = { favorites: [], usage: [] }; }
  list() {
    let data = this.memory;
    if (this.file) {
      try { data = JSON.parse(readFileSync(this.file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; data = { favorites: [], usage: [] }; }
    }
    if (!data || !Array.isArray(data.favorites) || !Array.isArray(data.usage) || !data.favorites.every(reference)
      || !data.usage.every(item => reference(item) && Number.isSafeInteger(item.count) && item.count > 0 && Number.isFinite(item.lastUsed))) throw new Error('Invalid model preferences');
    return { favorites: data.favorites, usage: data.usage };
  }
  write(data) {
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.tmp';
      writeFileSync(temporary, JSON.stringify({ version: 1, ...data }), { mode: 0o600 });
      renameSync(temporary, this.file);
    }
    this.memory = data;
    return data;
  }
  recordUse(provider, model, name, now = Date.now()) {
    const data = this.list();
    const previous = data.usage.find(item => key(item) === key({ provider, model }));
    const used = { provider, model, name: name || model, count: (previous?.count ?? 0) + 1, lastUsed: now };
    // Keep the most recently used models; the oldest fall out first.
    const usage = [used, ...data.usage.filter(item => item !== previous)].slice(0, MAX_USAGE);
    return this.write({ ...data, usage });
  }
  /** Combines favorites and usage from a backup with the ones saved here. */
  merge(incoming) {
    const data = this.list();
    const favorites = [...data.favorites];
    for (const item of Array.isArray(incoming.favorites) ? incoming.favorites : []) {
      if (reference(item) && favorites.length < MAX_FAVORITES && !favorites.some(favorite => key(favorite) === key(item))) favorites.push({ provider: item.provider, model: item.model, name: item.name });
    }
    const usage = new Map(data.usage.map(item => [key(item), item]));
    for (const item of Array.isArray(incoming.usage) ? incoming.usage : []) {
      if (!reference(item) || !Number.isSafeInteger(item.count) || item.count < 1 || !Number.isFinite(item.lastUsed)) continue;
      const local = usage.get(key(item));
      usage.set(key(item), local ? { ...local, count: Math.max(local.count, item.count), lastUsed: Math.max(local.lastUsed, item.lastUsed) } : { provider: item.provider, model: item.model, name: item.name, count: item.count, lastUsed: item.lastUsed });
    }
    return this.write({ favorites, usage: [...usage.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_USAGE) });
  }
  setFavorite(provider, model, name, favorite) {
    const data = this.list();
    const others = data.favorites.filter(item => key(item) !== key({ provider, model }));
    if (favorite && others.length >= MAX_FAVORITES) throw new Error(`You can keep up to ${MAX_FAVORITES} favorite models. Remove one first.`);
    return this.write({ ...data, favorites: favorite ? [...others, { provider, model, name: name || model }] : others });
  }
}
