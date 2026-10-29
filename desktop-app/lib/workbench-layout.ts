/** A pane is either an editor with its own tabs or one terminal. */
export type EditorPane = { id: string; kind: 'editor'; files: string[]; active?: string };
export type TerminalPane = { id: string; kind: 'terminal'; terminalId?: string; shell?: string; exited?: boolean; error?: string };
export type Pane = EditorPane | TerminalPane;
/** Panes are laid out by binary splits: `row` places a beside b, `column` places a above b. */
export type LayoutNode = { type: 'pane'; id: string } | { type: 'split'; id: string; direction: 'row' | 'column'; ratio: number; a: LayoutNode; b: LayoutNode };
export type Layout = { root: LayoutNode; panes: Record<string, Pane>; focused: string };

let counter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function emptyLayout(): Layout {
  const id = newId('pane');
  return { root: { type: 'pane', id }, panes: { [id]: { id, kind: 'editor', files: [] } }, focused: id };
}

export function paneIds(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.id] : [...paneIds(node.a), ...paneIds(node.b)];
}

/** Put `pane` beside or below `target`; it takes the share given by `ratio` from the original. */
export function splitPane(layout: Layout, target: string, pane: Pane, direction: 'row' | 'column', ratio = 0.5): Layout {
  const replace = (node: LayoutNode): LayoutNode => node.type === 'pane'
    ? node.id === target ? { type: 'split', id: newId('split'), direction, ratio, a: node, b: { type: 'pane', id: pane.id } } : node
    : { ...node, a: replace(node.a), b: replace(node.b) };
  return { root: replace(layout.root), panes: { ...layout.panes, [pane.id]: pane }, focused: pane.id };
}

/** Remove a pane; its sibling takes the space. The last pane is replaced by an empty editor. */
export function removePane(layout: Layout, target: string): Layout {
  if (layout.root.type === 'pane') return layout.root.id === target ? emptyLayout() : layout;
  const prune = (node: LayoutNode): LayoutNode | null => {
    if (node.type === 'pane') return node.id === target ? null : node;
    const a = prune(node.a), b = prune(node.b);
    if (!a) return b; if (!b) return a;
    return { ...node, a, b };
  };
  const root = prune(layout.root) ?? emptyLayout().root;
  const panes = { ...layout.panes };
  delete panes[target];
  const remaining = paneIds(root);
  return { root, panes, focused: remaining.includes(layout.focused) ? layout.focused : remaining[0] };
}

export function setRatio(layout: Layout, split: string, ratio: number): Layout {
  const clamp = Math.min(0.85, Math.max(0.15, ratio));
  const update = (node: LayoutNode): LayoutNode => node.type === 'pane' ? node : node.id === split ? { ...node, ratio: clamp } : { ...node, a: update(node.a), b: update(node.b) };
  return { ...layout, root: update(layout.root) };
}

export function updatePane(layout: Layout, id: string, change: Partial<EditorPane> | Partial<TerminalPane>): Layout {
  const pane = layout.panes[id];
  return pane ? { ...layout, panes: { ...layout.panes, [id]: { ...pane, ...change } as Pane } } : layout;
}

/** Where a file opens: the focused editor, else the first editor, else a new editor above everything. */
export function openInEditor(layout: Layout, path: string): Layout {
  const editors = paneIds(layout.root).map(id => layout.panes[id]).filter((pane): pane is EditorPane => pane.kind === 'editor');
  const focused = layout.panes[layout.focused];
  let target = focused?.kind === 'editor' ? focused : editors[0];
  let next = layout;
  if (!target) {
    const id = newId('pane');
    target = { id, kind: 'editor', files: [] };
    next = { root: { type: 'split', id: newId('split'), direction: 'column', ratio: 0.6, a: { type: 'pane', id }, b: layout.root }, panes: { ...layout.panes, [id]: target }, focused: id };
  }
  const files = target.files.includes(path) ? target.files : [...target.files, path];
  return { ...updatePane(next, target.id, { files, active: path }), focused: target.id };
}

/** Close a tab; the neighbour to its right (or left) becomes active. */
export function closeFile(layout: Layout, paneId: string, path: string): Layout {
  const pane = layout.panes[paneId];
  if (pane?.kind !== 'editor') return layout;
  const index = pane.files.indexOf(path);
  const files = pane.files.filter(file => file !== path);
  const active = pane.active === path ? files[Math.min(index, files.length - 1)] : pane.active;
  return updatePane(layout, paneId, { files, active });
}

/** Files still shown in some editor; the rest can let go of their text. */
export function filesInUse(layout: Layout): Set<string> {
  return new Set(Object.values(layout.panes).flatMap(pane => pane.kind === 'editor' ? pane.files : []));
}
