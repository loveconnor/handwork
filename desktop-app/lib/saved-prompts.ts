import type { SavedPrompt } from './desktop-api';

const VARIABLE = /\{\{\s*([\w][\w -]{0,39}?)\s*\}\}/g;

/** Distinct `{{name}}` placeholders, in the order they first appear. */
export function promptVariables(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(VARIABLE)) if (!names.includes(match[1])) names.push(match[1]);
  return names;
}

export function fillPrompt(text: string, values: Record<string, string>): string {
  return text.replace(VARIABLE, (whole, name: string) => values[name]?.trim() ? values[name].trim() : whole);
}

/** The `/name` a prompt answers to in the composer. */
export function promptSlug(prompt: Pick<SavedPrompt, 'title'>): string {
  return prompt.title.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'prompt';
}

export function humanizeVariable(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Case-insensitive ranking: every word must appear; earlier and word-start hits rank higher. */
export function matchScore(haystack: string, query: string): number {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const text = haystack.toLowerCase();
  let score = 0;
  for (const word of words) {
    const index = text.indexOf(word);
    if (index < 0) return 0;
    score += index === 0 ? 4 : /[\s/·._-]/.test(text[index - 1]) ? 2 : 1;
  }
  return score;
}

const mac = typeof navigator !== 'undefined' && /Macintosh/.test(navigator.userAgent);
/** Displays an accelerator such as "Mod+Shift+K" in the platform's notation. */
export function shortcutLabel(keys: string): string {
  const parts = keys.split('+');
  if (!mac) return parts.map(part => part === 'Mod' ? 'Ctrl' : part).join('+');
  const symbols: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Control: '⌃', Enter: '↵', Space: 'Space' };
  return parts.map(part => symbols[part] ?? part).join('');
}
export const isMac = mac;
