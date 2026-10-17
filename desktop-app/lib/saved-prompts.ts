import type { SavedPrompt } from './desktop-api';

export const VARIABLE = /\{\{\s*([\w][\w -]{0,39}?)\s*\}\}/g;

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
const keyNames: Record<string, [mac: string, other: string]> = {
  Mod: ['⌘', 'Ctrl'], Shift: ['⇧', 'Shift'], Alt: ['⌥', 'Alt'], Control: ['⌃', 'Ctrl'], Enter: ['↵', 'Enter'], Space: ['Space', 'Space'],
  Escape: ['Esc', 'Esc'], Backspace: ['⌫', 'Backspace'], Tab: ['⇥', 'Tab'], ArrowUp: ['↑', '↑'], ArrowDown: ['↓', '↓'], Plus: ['+', '+'], Minus: ['−', '−'],
};
/** The keys of an accelerator such as "Mod+Shift+K", each in the platform's notation. */
export function shortcutKeys(keys: string, onMac = mac): string[] {
  return keys.split('+').map(part => Object.hasOwn(keyNames, part) ? keyNames[part][onMac ? 0 : 1] : part);
}
/** Displays an accelerator such as "Mod+Shift+K" in the platform's notation. */
export function shortcutLabel(keys: string): string {
  return shortcutKeys(keys).join(mac ? '' : '+');
}
export const isMac = mac;

/** How a `{{field}}` is best entered, guessed from its name. */
export type PromptFieldKind = 'text' | 'long' | 'url' | 'email' | 'number';
const LONG = /(change|diff|code|snippet|text|notes?|context|details?|description|content|body|question|summary|log|error|stack|trace|draft|message|requirements?|spec|instructions?)$/i;

export function promptFieldKind(name: string): PromptFieldKind {
  if (/(url|link|website|href)$/i.test(name)) return 'url';
  if (/email$/i.test(name)) return 'email';
  if (/(count|number|amount|limit|words|minutes|hours|days)$/i.test(name)) return 'number';
  return LONG.test(name) ? 'long' : 'text';
}

const placeholders: Record<PromptFieldKind, (label: string) => string> = {
  text: label => `Enter ${label.toLowerCase()}`,
  long: label => `Paste or describe the ${label.toLowerCase()}`,
  url: () => 'https://',
  email: () => 'name@example.com',
  number: () => '0',
};

const quote = (value: string) => JSON.stringify(value);
export const fieldBinding = (index: number) => `$field${index}`;

/**
 * A Honest AI form with one input per prompt field, as honestai-lang source. Values
 * are bound to `$field0`, `$field1`, … so the host reads them as the person types.
 */
export function promptFormSource(names: string[], values: Record<string, string> = {}): string {
  const lines = names.map((name, index) => `${fieldBinding(index)} = ${quote(values[name] ?? '')}`);
  names.forEach((name, index) => {
    const label = humanizeVariable(name);
    const kind = promptFieldKind(name);
    const placeholder = quote(placeholders[kind](label));
    const input = kind === 'long'
      ? `TextArea(${quote(name)}, ${placeholder}, 4, {maxLength: 4000}, ${fieldBinding(index)})`
      : `Input(${quote(name)}, ${placeholder}, ${quote(kind)}, {maxLength: 4000}, ${fieldBinding(index)})`;
    lines.push(`control${index} = FormControl(${quote(label)}, ${input})`);
  });
  lines.push('actions = Buttons([])');
  lines.push(`form = Form("prompt_fields", actions, [${names.map((_, index) => `control${index}`).join(', ')}])`);
  lines.push('root = Stack([form])');
  return lines.join('\n');
}

/** Field values from the form's live state, by field name. */
export function promptFormValues(state: Record<string, unknown>, names: string[]): Record<string, string> {
  const form = state.prompt_fields && typeof state.prompt_fields === 'object' ? state.prompt_fields as Record<string, { value?: unknown }> : {};
  return Object.fromEntries(names.map((name, index) => {
    const bound = state[fieldBinding(index)];
    const value = typeof bound === 'string' ? bound : form[name]?.value;
    return [name, typeof value === 'string' ? value : value == null ? '' : String(value)];
  }));
}

/** The prompt split into text and fields, for showing what will be inserted. */
export function promptParts(text: string): ({ kind: 'text'; text: string } | { kind: 'field'; name: string })[] {
  const parts: ({ kind: 'text'; text: string } | { kind: 'field'; name: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(VARIABLE)) {
    if (match.index > last) parts.push({ kind: 'text', text: text.slice(last, match.index) });
    parts.push({ kind: 'field', name: match[1] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}
