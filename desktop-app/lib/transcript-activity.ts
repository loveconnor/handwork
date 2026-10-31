import type { Entry } from './desktop-state';

export type TranscriptBlock = { kind: 'entry'; entry: Entry } | { kind: 'activity'; entries: Entry[]; active: boolean };

/** Keep progress messages visible, collapsing only the activity between them. */
export function transcriptBlocks(entries: Entry[], busy: boolean): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const entry of entries) {
    if (entry.kind === 'user' || entry.kind === 'assistant') {
      blocks.push({ kind: 'entry', entry });
      continue;
    }
    const previous = blocks.at(-1);
    if (previous?.kind === 'activity') previous.entries.push(entry);
    else blocks.push({ kind: 'activity', entries: [entry], active: false });
  }
  const latest = blocks.at(-1);
  if (busy && latest?.kind === 'activity') latest.active = true;
  return blocks;
}

/** Keep raw arguments out of the readable activity labels. */
export function toolLabel(entry: Entry): string {
  const title = entry.title || 'Tool';
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(entry.input || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return title;
    input = parsed as Record<string, unknown>;
  } catch { return title; }
  const verb = /^(read|reading)$/i.test(title) ? 'Read'
    : /^(edit|editing)$/i.test(title) ? 'Edit'
    : /^(write|writing)$/i.test(title) ? 'Write'
    : /^(run|running)$/i.test(title) ? 'Run'
    : /^(search|searching|matching)$/i.test(title) ? 'Search' : '';
  if (!verb) return title;
  const files = Array.isArray(input.files) ? input.files : [];
  const first = files[0] as { path?: unknown } | undefined;
  const target = verb === 'Run' ? input.command : input.path ?? first?.path ?? input.pattern;
  if (typeof target !== 'string' || !target.trim()) return title;
  const short = verb === 'Run' ? target.split('\n')[0] : target.split('/').filter(Boolean).at(-1) || target;
  return `${verb} ${short.length > 80 ? `${short.slice(0, 77)}…` : short}${files.length > 1 ? ` +${files.length - 1} more` : ''}`;
}
