import type { Attachment, SavedDraft } from './desktop-api';

// Compare content references once per attachment rather than copying large payloads
// into a key on every keystroke. New objects and changed payloads get new tokens.
const attachments = new WeakMap<Attachment, { snapshot: Attachment; token: number }>();
let nextToken = 0;
function attachmentToken(file: Attachment): number {
  const cached = attachments.get(file);
  const old = cached?.snapshot;
  if (old && old.name === file.name && old.mimeType === file.mimeType && old.size === file.size && old.data === file.data && old.text === file.text && old.uri === file.uri) return cached!.token;
  const token = ++nextToken;
  attachments.set(file, { snapshot: { ...file }, token });
  return token;
}

export function draftKey(text: string, files: Attachment[]): string {
  return `${text}\u0000${files.map(attachmentToken).join(',')}`;
}

export function splitDrafts(entries: SavedDraft[], known: Set<string>): { known: SavedDraft[]; orphans: SavedDraft[] } {
  const result = { known: [] as SavedDraft[], orphans: [] as SavedDraft[] };
  for (const entry of entries) (known.has(entry.id) ? result.known : result.orphans).push(entry);
  return result;
}
