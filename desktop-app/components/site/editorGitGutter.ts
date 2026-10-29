import { Chunk } from '@codemirror/merge';
import { RangeSet, StateEffect, StateField, Text, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, GutterMarker, gutter } from '@codemirror/view';

/**
 * Bars beside the line numbers for lines added, changed or deleted since the
 * file was last staged in git, updated as you type.
 */
const DIFF_CONFIG = { scanLimit: 5000, timeout: 100 };

type GitBase = { base: Text | null; chunks: readonly Chunk[] };
/** Sets the text to compare against, or null for a file git does not track. */
export const setGitBase = StateEffect.define<string | null>();

const toText = (text: string) => Text.of(text.split(/\r\n?|\n/));
const gitBase = StateField.define<GitBase>({
  create: () => ({ base: null, chunks: [] }),
  update(value, transaction) {
    let base = value.base, replaced = false;
    for (const effect of transaction.effects) if (effect.is(setGitBase)) { base = effect.value === null ? null : toText(effect.value); replaced = true; }
    if (!base) return value.base ? { base: null, chunks: [] } : value;
    if (!replaced && !transaction.docChanged) return value;
    return { base, chunks: Chunk.build(base, transaction.state.doc, DIFF_CONFIG) };
  },
});

/** Whether `text` is already the base, so the caller does not reset it needlessly. */
export function hasGitBase(state: EditorState, text: string | null) {
  const { base } = state.field(gitBase, false) ?? { base: null };
  return text === null ? base === null : !!base && base.eq(toText(text));
}

class ChangeMarker extends GutterMarker {
  readonly kind: 'added' | 'modified' | 'deleted';
  constructor(kind: ChangeMarker['kind']) { super(); this.kind = kind; this.elementClass = `cm-gitChange cm-gitChange-${kind}`; }
  eq(other: ChangeMarker) { return other.kind === this.kind; }
}
const markers = { added: new ChangeMarker('added'), modified: new ChangeMarker('modified'), deleted: new ChangeMarker('deleted') };

type ChangeKind = ChangeMarker['kind'];
/** Each changed line by number, and how: deleted marks the line the removed lines sat above. */
export function changedLines(state: EditorState): { line: number; kind: ChangeKind }[] {
  const doc = state.doc;
  const lines: { line: number; kind: ChangeKind }[] = [];
  for (const chunk of state.field(gitBase, false)?.chunks ?? []) {
    if (chunk.fromB >= chunk.toB) { lines.push({ line: doc.lineAt(Math.min(chunk.fromB, doc.length)).number, kind: 'deleted' }); continue; }
    const kind = chunk.fromA >= chunk.toA ? 'added' : 'modified';
    const first = doc.lineAt(chunk.fromB).number;
    // Chunk ends are the start of the next line; the last line changed is the one before.
    const last = doc.lineAt(Math.max(chunk.fromB, Math.min(chunk.toB, doc.length + 1) - 1)).number;
    for (let line = first; line <= last; line++) lines.push({ line, kind });
  }
  return lines;
}

const cache = new WeakMap<readonly Chunk[], RangeSet<GutterMarker>>();
function changeMarkers(state: EditorState) {
  const { chunks } = state.field(gitBase);
  const cached = cache.get(chunks);
  if (cached) return cached;
  const set = RangeSet.of(changedLines(state).map(({ line, kind }) => markers[kind].range(state.doc.line(line).from)), true);
  cache.set(chunks, set);
  return set;
}

const theme = EditorView.theme({
  '.cm-gitGutter': { width: '3px', marginLeft: '2px' },
  '.cm-gitGutter .cm-gutterElement': { padding: '0' },
  '.cm-gitChange-added': { background: 'var(--hui-color-foreground-success-primary, #3fa36b)' },
  '.cm-gitChange-modified': { background: 'var(--hui-color-foreground-info-primary, #3b82f6)' },
  '.cm-gitChange-deleted': { background: 'linear-gradient(to bottom, var(--hui-color-foreground-danger-primary, #e5484d) 0 3px, transparent 3px)' },
});

export function gitGutter(): Extension {
  return [gitBase, gutter({ class: 'cm-gitGutter', markers: view => changeMarkers(view.state), lineMarkerChange: update => update.state.field(gitBase) !== update.startState.field(gitBase) }), theme];
}
