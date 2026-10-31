/** A pane is either an editor with its own tabs or one terminal. */
export type EditorPane = { id: string; kind: 'editor'; files: string[]; active?: string };
/** One shell in a terminal pane; it starts once shown, and `terminalId` names it once it runs. `number` stays with it as others close. */
export type TerminalTab = { id: string; number?: number; terminalId?: string; shell?: string; exited?: boolean; error?: string };
/** A terminal pane holds shells as tabs, one shown at a time. */
export type TerminalPane = { id: string; kind: 'terminal'; tabs: TerminalTab[]; active: string };
export type Pane = EditorPane | TerminalPane;
/** Panes are laid out by binary splits: `row` places a beside b, `column` places a above b. */
export type LayoutNode = { type: 'pane'; id: string } | { type: 'split'; id: string; direction: 'row' | 'column'; ratio: number; a: LayoutNode; b: LayoutNode };
export type Layout = { root: LayoutNode; panes: Record<string, Pane>; focused: string };

let counter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function terminalPane(id = newId('pane')): TerminalPane {
  const tab = newId('shell');
  return { id, kind: 'terminal', tabs: [{ id: tab, number: 1 }], active: tab };
}

/** Open another shell as a tab in a terminal pane, and show it. */
export function addTerminalTab(layout: Layout, paneId: string): Layout {
  const pane = layout.panes[paneId];
  if (pane?.kind !== 'terminal') return layout;
  const tab = newId('shell');
  const number = Math.max(0, ...pane.tabs.map((item, index) => item.number ?? index + 1)) + 1;
  return { ...layout, focused: paneId, panes: { ...layout.panes, [paneId]: { ...pane, tabs: [...pane.tabs, { id: tab, number }], active: tab } } };
}

/** Close a shell's tab; its neighbour is shown, and a pane with no shells left closes. */
export function closeTerminalTab(layout: Layout, paneId: string, tabId: string): Layout {
  const pane = layout.panes[paneId];
  if (pane?.kind !== 'terminal') return layout;
  const index = pane.tabs.findIndex(tab => tab.id === tabId);
  if (index < 0) return layout;
  const tabs = pane.tabs.filter(tab => tab.id !== tabId);
  if (!tabs.length) return removePane(layout, paneId);
  const active = pane.active === tabId ? tabs[Math.min(index, tabs.length - 1)].id : pane.active;
  return { ...layout, panes: { ...layout.panes, [paneId]: { ...pane, tabs, active } } };
}

export function updateTerminalTab(layout: Layout, paneId: string, tabId: string, change: Partial<TerminalTab>): Layout {
  const pane = layout.panes[paneId];
  if (pane?.kind !== 'terminal' || !pane.tabs.some(tab => tab.id === tabId)) return layout;
  return { ...layout, panes: { ...layout.panes, [paneId]: { ...pane, tabs: pane.tabs.map(tab => tab.id === tabId ? { ...tab, ...change } : tab) } } };
}

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

/** `path`, or a path inside the folder `path`. */
export const isWithin = (file: string, path: string) => file === path || file.startsWith(`${path}/`);
/** Where `file` ends up when `from` is renamed to `to`; files elsewhere stay put. */
export const movedPath = (file: string, from: string, to: string) => isWithin(file, from) ? to + file.slice(from.length) : file;

/** Tabs follow a renamed file, or every file in a renamed folder. */
export function renameInLayout(layout: Layout, from: string, to: string): Layout {
  const panes = Object.fromEntries(Object.entries(layout.panes).map(([id, pane]) => [id, pane.kind === 'editor'
    ? { ...pane, files: pane.files.map(file => movedPath(file, from, to)), active: pane.active && movedPath(pane.active, from, to) }
    : pane]));
  return { ...layout, panes };
}

/** Close every tab showing `path`, or a file inside the folder `path`. */
export function closeWithin(layout: Layout, path: string): Layout {
  let next = layout;
  for (const pane of Object.values(layout.panes)) {
    if (pane.kind !== 'editor') continue;
    for (const file of pane.files) if (isWithin(file, path)) next = closeFile(next, pane.id, file);
  }
  return next;
}

/** The layout kept between launches. Terminals start a new shell in their place, so nothing about the old one is kept. */
export function restorableLayout(layout: Layout): Layout {
  const panes = Object.fromEntries(Object.entries(layout.panes).map(([id, pane]) => [id, pane.kind === 'terminal' ? { ...pane, tabs: pane.tabs.map(tab => ({ id: tab.id, number: tab.number })) } : pane])) as Record<string, Pane>;
  return { ...layout, panes };
}

/** A saved layout read back, or null when it is not one this version can show. */
export function readLayout(value: unknown): Layout | null {
  if (!value || typeof value !== 'object') return null;
  const { root, panes, focused } = value as Partial<Layout>;
  if (!panes || typeof panes !== 'object') return null;
  const seen = new Set<string>();
  const valid = (node: unknown, depth: number): node is LayoutNode => {
    if (!node || typeof node !== 'object' || depth > 32) return false;
    const item = node as LayoutNode;
    if (typeof item.id !== 'string') return false;
    if (item.type === 'pane') {
      const pane = (panes as Record<string, Pane>)[item.id];
      if (!pane || pane.id !== item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      if (pane.kind === 'terminal') {
        // A terminal pane saved before it had tabs comes back with one.
        if (!Array.isArray(pane.tabs) || !pane.tabs.length) Object.assign(pane, terminalPane(pane.id));
        if (!pane.tabs.every(tab => tab && typeof tab.id === 'string')) return false;
        if (!pane.tabs.some(tab => tab.id === pane.active)) pane.active = pane.tabs[0].id;
        return true;
      }
      return pane.kind === 'editor' && Array.isArray(pane.files) && pane.files.every(file => typeof file === 'string') && (pane.active === undefined || pane.files.includes(pane.active));
    }
    return item.type === 'split' && (item.direction === 'row' || item.direction === 'column') && typeof item.ratio === 'number' && item.ratio > 0 && item.ratio < 1 && valid(item.a, depth + 1) && valid(item.b, depth + 1);
  };
  if (!valid(root, 0) || seen.size !== Object.keys(panes).length) return null;
  return restorableLayout({ root, panes: panes as Record<string, Pane>, focused: typeof focused === 'string' && seen.has(focused) ? focused : [...seen][0] });
}
