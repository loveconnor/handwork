"use client";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { toggleComment } from '@codemirror/commands';
import { selectSelectionMatches } from '@codemirror/search';
import { Reorder, useReducedMotion } from 'motion/react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { ChevronRight, ChevronDown, Check, Copy, File, FilePlus, Folder, FolderOpen, FolderPlus, RefreshCw, X, LoaderCircle, Columns2, Rows2, Search, SquareTerminal, TextSearch, Pencil, Trash2, ExternalLink, Plus, Scissors, ClipboardPaste, CornerDownRight, ListTree, TextCursorInput, WandSparkles, Hash, ReplaceAll } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { HoverTooltip } from '@/components/ui/tooltip';
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuShortcut, MenuTrigger } from '@/components/ui/menu';
import { shortcutLabel } from '@/lib/saved-prompts';
import type { DesktopAPI, ProjectFileEntry, ProjectSearchMatch } from '@/lib/desktop-api';
import { addTerminalTab, closeFile, closeTerminalTab, closeWithin, emptyLayout, filesInUse, isWithin, movedPath, newId, openInEditor, readLayout, removePane, renameInLayout, restorableLayout, setRatio, splitPane, terminalPane, updatePane, updateTerminalTab, type EditorPane, type Layout, type LayoutNode, type TerminalPane } from '@/lib/workbench-layout';
import { HandworkCodeEditor, type EditorCursor, type EditorReveal, type EditorSelection } from './HandworkCodeEditor';
import { HandworkTerminal } from './HandworkTerminal';
import { HandworkMark } from './HandworkMark';
import { Markdown } from 'honestui/ai/markdown';
import { mathPlugins } from 'honestui/ai/markdown-math';
import { prepareMath } from '@/lib/markdown-math';
import { HandworkQuickOpen } from './HandworkQuickOpen';
import { HandworkProjectSearch, MatchList, groupMatches } from './HandworkProjectSearch';
import { LanguageSupport, type ServerStatus } from './editorLanguageServer';
import { SPRING_LAYOUT } from '@/lib/ease';

type OpenFile = {
  path: string;
  /** The text as edited, and as last loaded or saved, to tell whether it has changes. */
  text: string; saved: string; revision: string | null;
  status: 'loading' | 'ready' | 'binary' | 'tooLarge' | 'error';
  error?: string; conflict?: boolean; saving?: boolean;
  /** The file as last staged in git, for the editor's change bars; null when git does not track it. */
  base?: string | null;
};
/** `previews` are the Markdown files shown rendered rather than as source. */
type WorkbenchState = { layout: Layout; files: Record<string, OpenFile>; expanded: string[]; sidebar?: 'files' | 'search' | 'references'; previews?: string[] };
/** A name being typed in the tree: a new file or folder inside `parent`, or a new name for `path`. */
type TreeEdit = { kind: 'file' | 'directory'; parent: string; error?: string } | { kind: 'rename'; path: string; error?: string };
/** What a right-click in the tree acts on; '' is the project root. */
type MenuTarget = { path: string; kind: 'file' | 'directory' };

/**
 * Each project's workbench outlives the panel: closing it keeps open files,
 * unsaved edits and running terminals, and reopening picks them all back up.
 */
const saved = new Map<string, WorkbenchState>();
/** Each project's folder listings, so its tree shows at once when it is opened again and refreshes behind. */
type Listing = ProjectFileEntry[] | 'loading' | { error: string };
const listings = new Map<string, Map<string, Listing>>();
const editorStates = new Map<string, Map<string, EditorState>>();
/**
 * Language servers by project; they outlive the panel. The two projects used last keep theirs,
 * so switching back and forth finds them warm; older ones stop.
 */
const languages = new Map<string, LanguageSupport>();
const KEPT_LANGUAGE_PROJECTS = 2;

const cleanError = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);
const baseName = (file: string) => file.split('/').pop() || file;
const parentOf = (file: string) => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
const joinPath = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const isDirty = (file?: OpenFile) => !!file && file.status === 'ready' && file.text !== file.saved;
const isMarkdown = (path: string) => /\.(md|mdx|markdown)$/i.test(path);
/** Where a link in a rendered Markdown file points inside the project, or null for the web or the page itself. */
function projectLink(from: string, href: string): string | null {
  if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) return null;
  const parts = (href.startsWith('/') ? href.slice(1) : `${parentOf(from) ? `${parentOf(from)}/` : ''}${href}`).split(/[?#]/)[0].split('/');
  const resolved: string[] = [];
  for (const part of parts) { if (part === '..') { if (!resolved.length) return null; resolved.pop(); } else if (part && part !== '.') resolved.push(decodeURIComponent(part)); }
  return resolved.join('/') || null;
}

/**
 * Between launches each project keeps its layout, open folders, unsaved text and
 * cursors in local storage; files are read from disk again when it opens.
 * Unsaved text is capped so one large file cannot crowd out the rest.
 */
const storageKey = (workspace: string) => `handwork.workbench:${workspace}`;
const MAX_DRAFT = 512_000, MAX_DRAFTS = 2_000_000;
/** Unsaved text read back at launch, waiting for its file to load. */
const pendingDrafts = new Map<string, Map<string, string>>();
const cursors = new Map<string, Map<string, EditorCursor>>();
const emptyState = (): WorkbenchState => ({ layout: emptyLayout(), files: {}, expanded: [''] });
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function restore(workspace: string): WorkbenchState {
  if (!workspace) return emptyState();
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(workspace)) ?? 'null');
    const layout = readLayout(stored?.layout);
    if (!layout) return emptyState();
    const record = (value: unknown) => value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>) : [];
    pendingDrafts.set(workspace, new Map(record(stored.drafts).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
    cursors.set(workspace, new Map(record(stored.cursors).filter((entry): entry is [string, EditorCursor] => {
      const cursor = entry[1] as EditorCursor | null;
      return !!cursor && Number.isInteger(cursor.line) && Number.isInteger(cursor.column);
    })));
    return { layout, files: {}, expanded: [...new Set(['', ...strings(stored.expanded)])], sidebar: stored.sidebar === 'search' ? 'search' : 'files', previews: strings(stored.previews).filter(path => filesInUse(layout).has(path)) };
  } catch { return emptyState(); }
}

function persist(workspace: string, state: WorkbenchState) {
  if (!workspace) return;
  const inUse = filesInUse(state.layout);
  const drafts: Record<string, string> = {};
  let total = 0;
  const keep = (path: string, text: string) => { if (text.length <= MAX_DRAFT && total + text.length <= MAX_DRAFTS) { drafts[path] = text; total += text.length; } };
  for (const file of Object.values(state.files)) if (isDirty(file)) keep(file.path, file.text);
  // Text read back but not yet shown is kept until its file has loaded.
  for (const [path, text] of pendingDrafts.get(workspace) ?? []) if (inUse.has(path) && !(path in drafts)) keep(path, text);
  const kept = Object.fromEntries([...cursors.get(workspace) ?? []].filter(([path]) => inUse.has(path)));
  try {
    localStorage.setItem(storageKey(workspace), JSON.stringify({ layout: restorableLayout(state.layout), expanded: state.expanded, sidebar: state.sidebar === 'search' ? 'search' : 'files', previews: (state.previews ?? []).filter(path => inUse.has(path)), drafts, cursors: kept }));
  } catch { /* storage is optional */ }
}

/** What the IDE view's menus ask of the workbench. */
export type WorkbenchCommand = 'new-file' | 'new-folder' | 'quick-open' | 'save' | 'save-all' | 'close-editor' | 'reveal' | 'search'
  | 'split-right' | 'split-down' | 'definition' | 'references' | 'rename' | 'format' | 'new-terminal' | 'split-terminal';
export type WorkbenchRequest = { kind: 'terminal' | 'file' | 'command'; path?: string; line?: number; command?: WorkbenchCommand; at: number };
/** The file being worked on, and what is selected in it, for the chat to send along; `text` reads it as it is now, unsaved edits included. */
export type EditorContext = { path: string; absolute: string; selection: EditorSelection | null; text: () => string };

/**
 * The project's files and shells beside the chat: a tree to browse, and panes
 * that split side by side or stacked, each an editor with tabs or a terminal.
 * Saving checks the file has not changed on disk since it was opened, so an
 * agent's edit is never overwritten without asking.
 *
 * Given `treeHost`, `tabsHost` and `actionsHost`, as the IDE view does, the tree
 * moves into the app's sidebar, and the main editor's tabs and actions into the
 * app's title row. `onContext` hears which file and selection are being worked
 * on, and `onAsk` asks the chat about it; a new `refresh` reads open files again, as after an agent's reply.
 * With `projects`, the project's name above the tree switches to another one.
 */
export function HandworkWorkbench({ api, workspace, request, onClose, treeHost, tabsHost, actionsHost, onContext, onAsk, refresh, projects }: {
  api?: DesktopAPI; workspace: string; request?: WorkbenchRequest; onClose?: () => void;
  treeHost?: HTMLElement | null; tabsHost?: HTMLElement | null; actionsHost?: HTMLElement | null;
  onContext?: (context: EditorContext | null) => void; onAsk?: () => void; refresh?: number;
  projects?: { list: string[]; onSwitch: (project: string) => void; onOpen: () => void };
}) {
  const [state, setState] = useState<WorkbenchState>(() => saved.get(workspace) ?? restore(workspace));
  const shownProject = useRef(workspace);
  const [directories, setDirectoriesState] = useState<Map<string, Listing>>(() => listings.get(workspace) ?? new Map());
  // A listing that arrives after another project took over is kept for its own project only.
  const setDirectories = useCallback((change: Map<string, Listing> | ((current: Map<string, Listing>) => Map<string, Listing>)) => {
    if (shownProject.current !== workspace) {
      const current = listings.get(workspace) ?? new Map();
      listings.set(workspace, typeof change === 'function' ? change(current) : change);
      return;
    }
    setDirectoriesState(current => {
      const next = typeof change === 'function' ? change(current) : change;
      listings.set(workspace, next);
      return next;
    });
  }, [workspace]);
  const stateRef = useRef(state);
  stateRef.current = state;
  // For one render after the project changes, the state is still the last project's; it must not be saved as this one's.
  const stateOwner = useRef(workspace);
  // Written shortly after each change and as the window closes, so a quit keeps the latest.
  const persistTimer = useRef<number | undefined>(undefined);
  const persistNow = useCallback(() => { window.clearTimeout(persistTimer.current); persistTimer.current = undefined; if (stateOwner.current === workspace) persist(workspace, stateRef.current); }, [workspace]);
  const persistSoon = useCallback(() => { window.clearTimeout(persistTimer.current); persistTimer.current = window.setTimeout(persistNow, 400); }, [persistNow]);
  useEffect(() => { if (stateOwner.current !== workspace) return; saved.set(workspace, state); persistSoon(); }, [workspace, state, persistSoon]);
  useEffect(() => {
    window.addEventListener('beforeunload', persistNow);
    return () => { window.removeEventListener('beforeunload', persistNow); if (persistTimer.current !== undefined) persistNow(); };
  }, [persistNow]);

  const loadDirectory = useCallback(async (directory: string) => {
    if (!api?.listProjectFiles || !workspace) return;
    // A folder already listed keeps showing while it is read again.
    setDirectories(current => Array.isArray(current.get(directory)) ? current : new Map(current).set(directory, 'loading'));
    try { const result = await api.listProjectFiles(workspace, directory); setDirectories(current => new Map(current).set(directory, result.entries)); }
    catch (cause) { setDirectories(current => new Map(current).set(directory, { error: cleanError(cause) })); }
  }, [api, workspace, setDirectories]);

  // Another project brings its own workbench, as it was left, even in an earlier launch.
  useEffect(() => {
    const next = saved.get(workspace) ?? restore(workspace);
    stateOwner.current = workspace;
    shownProject.current = workspace;
    setState(next);
    // Files still loading when this project was left are read again.
    for (const path of filesInUse(next.layout)) if (!next.files[path] || next.files[path].status === 'loading') void loadFile(path);
    setDirectoriesState(listings.get(workspace) ?? new Map());
    if (workspace) for (const directory of next.expanded) void loadDirectory(directory);
  }, [workspace, loadDirectory]);

  const setLayout = (change: (layout: Layout) => Layout) => setState(current => ({ ...current, layout: change(current.layout) }));
  const reduceMotion = useReducedMotion();
  // A drag ends with a click on whatever is under the pointer; that click must not close or switch tabs.
  const dragging = useRef(false);
  // Each pane's tab strip; a dragged tab stays inside it, where the strip's clipping would otherwise hide it.
  const tabStrips = useRef(new Map<string, { current: HTMLDivElement | null }>());
  const tabStrip = (id: string) => { let strip = tabStrips.current.get(id); if (!strip) tabStrips.current.set(id, strip = { current: null }); return strip; };
  const updateFile = (path: string, change: Partial<OpenFile>) => setState(current => current.files[path] ? { ...current, files: { ...current.files, [path]: { ...current.files[path], ...change } } } : current);

  const loadBase = useCallback((path: string) => {
    if (!api?.projectFileBase) return;
    // Change bars are a nicety; without git they are simply not shown.
    api.projectFileBase(workspace, path).then(result => { if (shownProject.current === workspace) updateFile(path, { base: result.text }); }).catch(() => {});
  }, [api, workspace]);

  // Where the next opened file puts its cursor, from a search result.
  const [reveal, setReveal] = useState<(EditorReveal & { path: string }) | null>(null);
  const revealToken = useRef(0);
  /** Read a file into the workbench; unsaved text kept from the last launch goes back on top. */
  const loadFile = useCallback(async (path: string) => {
    if (!api) return;
    setState(current => ({ ...current, files: { ...current.files, [path]: { path, text: '', saved: '', revision: null, status: 'loading' } } }));
    try {
      const result = await api.readProjectFile(workspace, path);
      // Read for a project that is no longer shown: it is read again when that project returns.
      if (shownProject.current !== workspace) return;
      const editable = !result.tooLarge && !result.binary;
      const draft = editable ? pendingDrafts.get(workspace)?.get(path) : undefined;
      pendingDrafts.get(workspace)?.delete(path);
      updateFile(path, { status: result.tooLarge ? 'tooLarge' : result.binary ? 'binary' : 'ready', text: draft ?? result.text ?? '', saved: result.text ?? '', revision: result.revision });
      if (editable) loadBase(path);
    } catch (cause) { if (shownProject.current === workspace) updateFile(path, { status: 'error', error: cleanError(cause) }); }
  }, [api, workspace, loadBase]);
  const openFile = useCallback(async (path: string, at?: Omit<EditorReveal, 'token'>) => {
    setLayout(layout => openInEditor(layout, path));
    if (at) setReveal({ path, ...at, token: ++revealToken.current });
    if (!stateRef.current.files[path]) await loadFile(path);
  }, [loadFile]);

  // Language servers reach back into the workbench to show a file or change one no editor shows.
  const [references, setReferences] = useState<{ symbol: string; matches: ProjectSearchMatch[]; collapsed: string[] } | null>(null);
  const languageHooks = useRef({ open: (path: string) => void openFile(path), edit: async (_path: string, _change: (text: string) => string) => {}, references: (_symbol: string, _matches: ProjectSearchMatch[]) => {} });
  languageHooks.current.references = (symbol, matches) => { setReferences({ symbol, matches, collapsed: [] }); setState(current => ({ ...current, sidebar: 'references' })); };
  languageHooks.current.open = path => void openFile(path);
  languageHooks.current.edit = async (path, change) => {
    const open = stateRef.current.files[path];
    if (open?.status === 'ready') {
      for (const states of editorStates.values()) states.delete(path);
      updateFile(path, { text: change(open.text) });
      return;
    }
    const read = await api!.readProjectFile(workspace, path);
    if (read.text === null) throw new Error(`${baseName(path)} cannot be edited here.`);
    await api!.writeProjectFile(workspace, path, change(read.text), read.revision);
  };
  const [support, setSupport] = useState<LanguageSupport | null>(null);
  const [supportVersion, setSupportVersion] = useState(0);
  useEffect(() => {
    if (!api?.lspStart || !workspace) { setSupport(null); return; }
    let project = languages.get(workspace);
    if (project) languages.delete(workspace);
    else project = new LanguageSupport(api, workspace, { open: path => languageHooks.current.open(path), edit: (path, change) => languageHooks.current.edit(path, change), references: (symbol, matches) => languageHooks.current.references(symbol, matches) });
    // Most recent last; the oldest beyond the kept few stop.
    languages.set(workspace, project);
    for (const [other, support] of languages) if (languages.size > KEPT_LANGUAGE_PROJECTS && other !== workspace) { support.dispose(); languages.delete(other); }
    setSupport(project);
    return project.subscribe(() => setSupportVersion(count => count + 1));
  }, [api, workspace]);
  const editorSupport = useCallback((path: string) => support!.support(path), [support]);

  const newTerminal = useCallback((from?: string, direction?: 'row' | 'column') => setLayout(layout => {
    const target = from ?? layout.focused;
    // Below an editor by default, beside another terminal.
    return splitPane(layout, target, terminalPane(), direction ?? (layout.panes[target]?.kind === 'terminal' ? 'row' : 'column'), direction ? 0.5 : 0.6);
  }), []);
  /** Another shell as a tab in the terminal pane last used, or a new pane when there is none. */
  const newTerminalTab = useCallback(() => {
    const { panes, focused } = stateRef.current.layout;
    const pane = panes[focused]?.kind === 'terminal' ? panes[focused] : Object.values(panes).find(item => item.kind === 'terminal');
    if (pane) setLayout(layout => addTerminalTab(layout, pane.id)); else newTerminal();
  }, [newTerminal]);
  const closeShell = (paneId: string, tabId: string) => {
    const pane = stateRef.current.layout.panes[paneId];
    const tab = pane?.kind === 'terminal' ? pane.tabs.find(item => item.id === tabId) : undefined;
    if (tab?.terminalId) void api?.closeTerminal(tab.terminalId).catch(() => {});
    setLayout(layout => closeTerminalTab(layout, paneId, tabId));
  };

  const splitEditor = (from: string, direction: 'row' | 'column') => setLayout(layout => {
    const source = layout.panes[from];
    const active = source?.kind === 'editor' ? source.active : undefined;
    return splitPane(layout, from, { id: newId('pane'), kind: 'editor', files: active ? [active] : [], active }, direction);
  });

  const closePane = (id: string) => {
    const pane = stateRef.current.layout.panes[id];
    if (pane?.kind === 'editor') {
      const others = filesInUse(removePane(stateRef.current.layout, id));
      const unsaved = pane.files.filter(path => !others.has(path) && isDirty(stateRef.current.files[path]));
      if (unsaved.length && !window.confirm(`Close ${unsaved.length === 1 ? baseName(unsaved[0]) : `${unsaved.length} files`} without saving your changes?`)) return;
    }
    if (pane?.kind === 'terminal') for (const tab of pane.tabs) if (tab.terminalId) void api?.closeTerminal(tab.terminalId).catch(() => {});
    editorStates.delete(id);
    setState(current => {
      const layout = removePane(current.layout, id);
      const inUse = filesInUse(layout);
      return { ...current, layout, files: Object.fromEntries(Object.entries(current.files).filter(([path]) => inUse.has(path))) };
    });
  };

  const closeTab = (paneId: string, path: string) => {
    const others = filesInUse(closeFile(stateRef.current.layout, paneId, path));
    if (!others.has(path) && isDirty(stateRef.current.files[path]) && !window.confirm(`Close ${baseName(path)} without saving your changes?`)) return;
    editorStates.get(paneId)?.delete(path);
    setState(current => {
      const layout = closeFile(current.layout, paneId, path);
      const inUse = filesInUse(layout);
      return { ...current, layout, files: inUse.has(path) ? current.files : Object.fromEntries(Object.entries(current.files).filter(([file]) => file !== path)) };
    });
  };

  const save = useCallback(async (path: string, overwrite = false) => {
    const file = stateRef.current.files[path];
    if (!file || file.status !== 'ready' || file.saving || (!overwrite && file.text === file.saved)) return;
    updateFile(path, { saving: true, error: undefined });
    try {
      // Overwriting means replacing whatever is on disk now.
      const revision = overwrite ? (await api!.readProjectFile(workspace, path)).revision : file.revision;
      const result = await api!.writeProjectFile(workspace, path, file.text, revision);
      updateFile(path, { saving: false, saved: file.text, revision: result.revision, conflict: false });
    } catch (cause) {
      const message = cleanError(cause);
      const conflict = /changed on disk/.test(message);
      updateFile(path, { saving: false, conflict, error: conflict ? undefined : message });
    }
  }, [api, workspace]);

  const reload = async (path: string) => {
    try {
      const result = await api!.readProjectFile(workspace, path);
      for (const states of editorStates.values()) states.delete(path);
      updateFile(path, { text: result.text ?? '', saved: result.text ?? '', revision: result.revision, conflict: false, error: undefined, status: result.tooLarge ? 'tooLarge' : result.binary ? 'binary' : 'ready' });
      loadBase(path);
    } catch (cause) { updateFile(path, { error: cleanError(cause) }); }
  };

  // Making, renaming and deleting files from the tree.
  const [edit, setEdit] = useState<TreeEdit | null>(null);
  const [menuTarget, setMenuTarget] = useState<MenuTarget>({ path: '', kind: 'directory' });
  const [menuOpen, setMenuOpen] = useState(false);
  const [treeError, setTreeError] = useState('');
  // A menu item that starts typing a name must not have the menu hand focus back to the tree as it closes.
  const editStarting = useRef(false);
  const committing = useRef(false);
  const separator = workspace.includes('\\') && !workspace.includes('/') ? '\\' : '/';
  const absolute = (path: string) => path ? `${workspace.replace(/[\\/]+$/, '')}${separator}${path.split('/').join(separator)}` : workspace;

  const expand = (directories: string[]) => {
    const missing = directories.filter(directory => !stateRef.current.expanded.includes(directory));
    if (missing.length) setState(current => ({ ...current, expanded: [...current.expanded, ...missing.filter(directory => !current.expanded.includes(directory))] }));
    for (const directory of directories) void loadDirectory(directory);
  };
  const startCreate = (kind: 'file' | 'directory', parent: string) => {
    editStarting.current = menuOpen;
    setTreeError('');
    setState(current => ({ ...current, sidebar: 'files' }));
    if (parent) expand([parent]);
    setEdit({ kind, parent });
  };
  const startRename = (path: string) => { editStarting.current = menuOpen; setTreeError(''); setEdit({ kind: 'rename', path }); };

  /** Open tabs, unsaved text and editor history follow a renamed file or folder. */
  const applyRename = (from: string, to: string) => {
    setState(current => ({
      ...current,
      layout: renameInLayout(current.layout, from, to),
      files: Object.fromEntries(Object.entries(current.files).map(([path, file]) => { const next = movedPath(path, from, to); return [next, next === path ? file : { ...file, path: next }]; })),
      expanded: current.expanded.map(path => movedPath(path, from, to)),
    }));
    for (const states of editorStates.values()) for (const [path, saved] of [...states]) {
      const next = movedPath(path, from, to);
      if (next !== path) { states.delete(path); states.set(next, saved); }
    }
    setDirectories(current => new Map([...current].filter(([path]) => !isWithin(path, from))));
  };

  const commitEdit = async (value: string) => {
    const current = edit;
    if (!current || !api || committing.current) return;
    const name = value.trim().replace(/^\/+|\/+$/g, '');
    if (!name || (current.kind === 'rename' && name === baseName(current.path))) { setEdit(null); return; }
    if (name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) { setEdit({ ...current, error: 'Use a name without “..”, backslashes or empty folder names.' }); return; }
    committing.current = true;
    try {
      if (current.kind === 'rename') {
        const to = joinPath(parentOf(current.path), name);
        await api.renameProjectPath(workspace, current.path, to);
        // Open folders inside a renamed one are listed again at their new paths.
        for (const directory of stateRef.current.expanded) if (isWithin(directory, current.path)) void loadDirectory(movedPath(directory, current.path, to));
        applyRename(current.path, to);
        setEdit(null);
        // Folders typed into the new name open, so the renamed item can be seen.
        const folders = parentOf(to).split('/').filter(Boolean).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
        for (const directory of new Set([parentOf(current.path), parentOf(to)])) void loadDirectory(directory);
        expand(folders.filter(folder => !isWithin(parentOf(current.path), folder)));
      } else {
        const created = joinPath(current.parent, name);
        await api.createProjectPath(workspace, created, current.kind);
        setEdit(null);
        const folders = (current.kind === 'directory' ? created : parentOf(created)).split('/').filter(Boolean).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
        void loadDirectory(current.parent);
        expand(folders.filter(folder => folder.length > current.parent.length));
        if (current.kind === 'file') void openFile(created);
      }
    } catch (cause) { setEdit({ ...current, error: cleanError(cause) }); }
    finally { committing.current = false; }
  };

  const remove = async (target: MenuTarget) => {
    if (!api || !target.path) return;
    const unsaved = Object.values(stateRef.current.files).filter(file => isWithin(file.path, target.path) && isDirty(file));
    const label = baseName(target.path);
    const lost = unsaved.length ? ` Your unsaved changes to ${unsaved.length === 1 ? baseName(unsaved[0].path) : `${unsaved.length} files`} will be lost.` : '';
    if (!window.confirm(`Move ${target.kind === 'directory' ? `the folder “${label}” and everything in it` : `“${label}”`} to the Trash?${lost}`)) return;
    setTreeError('');
    try { await api.deleteProjectPath(workspace, target.path); }
    catch (cause) { setTreeError(cleanError(cause)); return; }
    for (const states of editorStates.values()) for (const path of [...states.keys()]) if (isWithin(path, target.path)) states.delete(path);
    setState(current => {
      const layout = closeWithin(current.layout, target.path);
      const inUse = filesInUse(layout);
      return { ...current, layout, files: Object.fromEntries(Object.entries(current.files).filter(([path]) => inUse.has(path))), expanded: current.expanded.filter(path => !isWithin(path, target.path)) };
    });
    setDirectories(current => new Map([...current].filter(([path]) => !isWithin(path, target.path))));
    void loadDirectory(parentOf(target.path));
  };

  const copyText = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => setTreeError('Could not copy to the clipboard.')); };
  const rowKeys = (event: ReactKeyboardEvent, entry: ProjectFileEntry) => {
    if (event.key === 'F2') { event.preventDefault(); startRename(entry.path); }
    else if ((event.key === 'Delete' && !event.metaKey) || (isMac && event.key === 'Backspace' && event.metaKey)) { event.preventDefault(); void remove(entry); }
  };

  // ⌘P finds a file by name; ⌘⇧F searches inside every file.
  const [quickOpen, setQuickOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const sidebar = state.sidebar ?? 'files';
  const showSearch = () => { setState(current => ({ ...current, sidebar: 'search' })); setSearchFocus(count => count + 1); };
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey || event.repeat) return;
      const key = event.key.toLowerCase();
      if (key === 'p' && !event.shiftKey) {
        if (document.querySelector('[role="dialog"]:not(.handwork-quick-open), [role="alertdialog"]')) return;
        event.preventDefault();
        setQuickOpen(open => !open);
      } else if (key === 'f' && event.shiftKey && !document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        event.preventDefault();
        showSearch();
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);

  // Requests from outside: the Terminal button, or a file named elsewhere in the app.
  useEffect(() => {
    if (!request) return;
    if (request.kind === 'file' && request.path) void openFile(request.path, request.line ? { line: request.line } : undefined);
    if (request.kind === 'terminal') {
      const existing = Object.values(stateRef.current.layout.panes).find(pane => pane.kind === 'terminal' && pane.tabs.some(tab => !tab.exited));
      if (existing) setLayout(layout => ({ ...layout, focused: existing.id })); else newTerminal();
    }
    if (request.kind === 'command' && request.command) runCommand(request.command);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // After an agent's reply, open files it changed are read again; one with edits of its own is flagged instead.
  useEffect(() => {
    if (!refresh || !api) return;
    void (async () => {
      for (const file of Object.values(stateRef.current.files)) {
        if (file.status !== 'ready' || file.saving) continue;
        const read = await api.readProjectFile(workspace, file.path).catch(() => null);
        const current = stateRef.current.files[file.path];
        if (!read || !current || read.revision === current.revision) continue;
        if (isDirty(current)) { updateFile(file.path, { conflict: true }); continue; }
        updateFile(file.path, { status: read.tooLarge ? 'tooLarge' : read.binary ? 'binary' : 'ready', text: read.text ?? '', saved: read.text ?? '', revision: read.revision, conflict: false });
        loadBase(file.path);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  /** A menu command, acting on the editor last worked in, as a key in it would. */
  const runCommand = (command: WorkbenchCommand) => {
    const { layout, files } = stateRef.current;
    const focused = layout.panes[layout.focused];
    const editor = (focused?.kind === 'editor' ? focused : layout.panes[lastEditor.current]?.kind === 'editor' ? layout.panes[lastEditor.current] : Object.values(layout.panes).find(pane => pane.kind === 'editor')) as EditorPane | undefined;
    const active = editor?.active;
    const view = () => { const element = editor && document.querySelector(`.handwork-pane[data-pane="${editor.id}"] .cm-editor`); return element instanceof HTMLElement ? EditorView.findFromDOM(element) : null; };
    switch (command) {
      case 'new-file': case 'new-folder': startCreate(command === 'new-file' ? 'file' : 'directory', active ? parentOf(active) : ''); break;
      case 'quick-open': setQuickOpen(true); break;
      case 'search': showSearch(); break;
      case 'save': if (active) void save(active); break;
      case 'save-all': for (const file of Object.values(files)) if (isDirty(file)) void save(file.path); break;
      case 'close-editor': if (editor && active) closeTab(editor.id, active); break;
      case 'reveal': if (active) void api?.revealFile(absolute(active)).catch(cause => setTreeError(cleanError(cause))); break;
      case 'split-right': case 'split-down': if (editor) splitEditor(editor.id, command === 'split-right' ? 'row' : 'column'); break;
      case 'new-terminal': newTerminalTab(); break;
      case 'split-terminal': newTerminal(focused?.kind === 'terminal' ? focused.id : undefined, focused?.kind === 'terminal' ? 'row' : undefined); break;
      case 'definition': case 'references': case 'rename': case 'format': { const target = view(); if (target) support?.command(command, target); }
    }
  };


  const toggleDirectory = (directory: string) => {
    const open = state.expanded.includes(directory);
    setState(current => ({ ...current, expanded: open ? current.expanded.filter(item => item !== directory) : [...current.expanded, directory] }));
    if (!open && !directories.has(directory)) void loadDirectory(directory);
  };

  const focusedPane = state.layout.panes[state.layout.focused];
  const activeFile = focusedPane?.kind === 'editor' ? focusedPane.active : undefined;
  // The editor whose tabs sit in the title row: the one last worked in, kept while a terminal has focus.
  const lastEditor = useRef('');
  if (focusedPane?.kind === 'editor') lastEditor.current = focusedPane.id;
  // The chat hears which file is being worked on, and the selection in it, as they change.
  const selections = useRef(new Map<string, EditorSelection | null>());
  const contextTimer = useRef<number | undefined>(undefined);
  const contextKey = useRef('');
  const reportContext = useRef(() => {});
  reportContext.current = () => {
    if (!onContext) return;
    const { layout, files } = stateRef.current;
    const pane = layout.panes[lastEditor.current]?.kind === 'editor' ? layout.panes[lastEditor.current] : Object.values(layout.panes).find(item => item.kind === 'editor');
    const path = pane?.kind === 'editor' ? pane.active : undefined;
    const ready = !!path && files[path]?.status === 'ready';
    const selection = ready ? selections.current.get(path) ?? null : null;
    const key = ready ? `${workspace}:${path}:${selection?.from ?? ''}-${selection?.to ?? ''}` : '';
    if (key === contextKey.current) return;
    contextKey.current = key;
    onContext(ready ? { path, absolute: absolute(path), selection, text: () => { const text = stateRef.current.files[path]?.text ?? ''; return selection ? text.slice(selection.from, selection.to) : text; } } : null);
  };
  const onContextRef = useRef(onContext);
  onContextRef.current = onContext;
  useEffect(() => reportContext.current());
  useEffect(() => () => { window.clearTimeout(contextTimer.current); contextKey.current = ''; onContextRef.current?.(null); }, []);

  const mainEditor = tabsHost === undefined ? undefined
    : state.layout.panes[lastEditor.current]?.kind === 'editor' ? lastEditor.current
    : Object.values(state.layout.panes).find(pane => pane.kind === 'editor')?.id;
  const nameInput = (kind: 'file' | 'directory', depth: number, initial: string, error?: string) => <TreeNameInput key={edit?.kind === 'rename' ? `rename:${edit.path}` : `new:${kind}`} kind={kind} depth={depth} initial={initial} error={error}
    onCommit={value => void commitEdit(value)} onCancel={() => setEdit(null)} />;
  const tree = (directory: string, depth: number): ReactNode => {
    const listing = directories.get(directory);
    const creating = edit && edit.kind !== 'rename' && edit.parent === directory ? nameInput(edit.kind, depth, '', edit.error) : null;
    if (!listing || listing === 'loading') return <>{creating}<div className="handwork-tree-note" style={{ paddingLeft: 12 + depth * 12 }}>Loading…</div></>;
    if ('error' in listing) return <div className="handwork-tree-note" data-error style={{ paddingLeft: 12 + depth * 12 }}>{listing.error}</div>;
    if (!listing.length) return creating ?? (depth === 0 ? <div className="handwork-tree-note">This project is empty.</div> : null);
    return <>{creating}{listing.map(entry => {
      const open = state.expanded.includes(entry.path);
      const current = entry.kind === 'file' && entry.path === activeFile;
      const renaming = edit?.kind === 'rename' && edit.path === entry.path;
      return <div key={entry.path} role="none">
        {renaming ? nameInput(entry.kind, depth, entry.name, edit.error)
          : <button type="button" role="treeitem" aria-level={depth + 1} aria-expanded={entry.kind === 'directory' ? open : undefined} aria-selected={current} className="handwork-tree-row" data-kind={entry.kind} data-current={current || undefined} data-ignored={entry.ignored || undefined} data-menu={menuOpen && menuTarget.path === entry.path || undefined} style={{ paddingLeft: 8 + depth * 12 }} title={entry.path}
            onClick={() => entry.kind === 'directory' ? toggleDirectory(entry.path) : void openFile(entry.path)}
            onContextMenu={() => setMenuTarget({ path: entry.path, kind: entry.kind })} onKeyDown={event => rowKeys(event, entry)}>
            {entry.kind === 'directory' ? <ChevronRight className="handwork-tree-chevron" data-open={open || undefined} aria-hidden /> : <span className="handwork-tree-chevron" aria-hidden />}
            {entry.kind === 'directory' ? (open ? <FolderOpen className="handwork-tree-icon" aria-hidden /> : <Folder className="handwork-tree-icon" aria-hidden />) : <File className="handwork-tree-icon" aria-hidden />}
            <span className="handwork-tree-name">{entry.name}</span>
          </button>}
        {entry.kind === 'directory' && open && <div role="group">{tree(entry.path, depth + 1)}</div>}
      </div>;
    })}</>;
  };

  const paneActions = (id: string, kind: 'editor' | 'terminal') => <div className="handwork-pane-actions">
    <HoverTooltip content="Split right"><Button size="icon-sm" variant="ghost" aria-label="Split right" onClick={() => kind === 'editor' ? splitEditor(id, 'row') : newTerminal(id, 'row')}><Columns2 aria-hidden width={14} height={14} /></Button></HoverTooltip>
    <HoverTooltip content="Split down"><Button size="icon-sm" variant="ghost" aria-label="Split down" onClick={() => kind === 'editor' ? splitEditor(id, 'column') : newTerminal(id, 'column')}><Rows2 aria-hidden width={14} height={14} /></Button></HoverTooltip>
    {kind === 'editor' && <HoverTooltip content="New terminal (⌃`)"><Button size="icon-sm" variant="ghost" aria-label="New terminal" onClick={() => newTerminal(id)}><SquareTerminal aria-hidden width={14} height={14} /></Button></HoverTooltip>}
    {Object.keys(state.layout.panes).length > 1 && <HoverTooltip content={kind === 'terminal' ? 'Close terminal' : 'Close pane'}><Button size="icon-sm" variant="ghost" aria-label={kind === 'terminal' ? 'Close terminal' : 'Close pane'} onClick={() => closePane(id)}><X aria-hidden width={14} height={14} /></Button></HoverTooltip>}
  </div>;

  // Right-click in an editor: what other editors offer, for the selection or the symbol under it.
  const [editorMenu, setEditorMenu] = useState<{ paneId: string; path: string; selected: boolean } | null>(null);
  const editorView = (paneId: string) => {
    const element = document.querySelector(`.handwork-pane[data-pane="${paneId}"] .cm-editor`);
    return element instanceof HTMLElement ? EditorView.findFromDOM(element) : null;
  };
  const inEditor = (run: (view: EditorView) => unknown) => () => {
    const view = editorMenu && editorView(editorMenu.paneId);
    if (!view) return;
    // The menu hands focus back as it closes; the command runs once the editor has it again.
    window.setTimeout(() => { view.focus(); run(view); });
  };
  const editorMenuItems = () => {
    if (!editorMenu) return null;
    const { path, selected } = editorMenu;
    const served = support?.status(path)?.state === 'ready';
    const language = (name: 'definition' | 'references' | 'rename' | 'format') => inEditor(view => { support?.command(name, view); });
    const clipboard = (action: 'cut' | 'copy' | 'paste') => inEditor(() => { void api?.editAction?.(action).catch(() => {}); });
    return <>
      {served && <>
        <MenuItem onClick={language('definition')}><CornerDownRight aria-hidden />Go to Definition<MenuShortcut>F12</MenuShortcut></MenuItem>
        <MenuItem onClick={language('references')}><ListTree aria-hidden />Find References<MenuShortcut>{shortcutLabel('Shift+F12')}</MenuShortcut></MenuItem>
        <MenuItem onClick={language('rename')}><TextCursorInput aria-hidden />Rename Symbol<MenuShortcut>F2</MenuShortcut></MenuItem>
        <MenuSeparator />
      </>}
      {onAsk && <>
        <MenuItem onClick={() => onAsk()}><HandworkMark className="handwork-menu-mark" />{selected ? 'Ask Handwork about Selection' : 'Ask Handwork about File'}<MenuShortcut>{shortcutLabel('Mod+L')}</MenuShortcut></MenuItem>
        <MenuSeparator />
      </>}
      <MenuItem disabled={!selected} onClick={clipboard('cut')}><Scissors aria-hidden />Cut<MenuShortcut>{shortcutLabel('Mod+X')}</MenuShortcut></MenuItem>
      <MenuItem disabled={!selected} onClick={clipboard('copy')}><Copy aria-hidden />Copy<MenuShortcut>{shortcutLabel('Mod+C')}</MenuShortcut></MenuItem>
      <MenuItem onClick={clipboard('paste')}><ClipboardPaste aria-hidden />Paste<MenuShortcut>{shortcutLabel('Mod+V')}</MenuShortcut></MenuItem>
      <MenuSeparator />
      <MenuItem onClick={inEditor(view => { toggleComment(view); })}><Hash aria-hidden />Toggle Line Comment<MenuShortcut>{shortcutLabel('Mod+/')}</MenuShortcut></MenuItem>
      {selected && <MenuItem onClick={inEditor(view => { selectSelectionMatches(view); })}><ReplaceAll aria-hidden />Select All Occurrences<MenuShortcut>{shortcutLabel('Shift+Mod+L')}</MenuShortcut></MenuItem>}
      {served && <MenuItem onClick={language('format')}><WandSparkles aria-hidden />Format Document<MenuShortcut>{shortcutLabel('Shift+Alt+F')}</MenuShortcut></MenuItem>}
      <MenuSeparator />
      <MenuItem onClick={() => copyText(absolute(path))}><Copy aria-hidden />Copy Path</MenuItem>
      <MenuItem onClick={() => copyText(path)}><Copy aria-hidden />Copy Relative Path</MenuItem>
      {api?.revealFile && <MenuItem onClick={() => void api.revealFile(absolute(path)).catch(cause => setTreeError(cleanError(cause)))}><ExternalLink aria-hidden />{isMac ? 'Reveal in Finder' : 'Show in Folder'}</MenuItem>}
    </>;
  };

  const editorPane = (pane: EditorPane) => {
    const file = pane.active ? state.files[pane.active] : undefined;
    const previewing = !!file && file.status === 'ready' && isMarkdown(file.path) && !!state.previews?.includes(file.path);
    let states = editorStates.get(pane.id);
    if (!states) editorStates.set(pane.id, states = new Map());
    const strip = tabStrip(pane.id);
    const tabs = <Reorder.Group ref={strip} as="div" axis="x" layoutScroll values={pane.files} onReorder={files => setLayout(layout => updatePane(layout, pane.id, { files }))} className="handwork-editor-tabs" role="tablist" aria-label="Open files">{pane.files.map(path => {
          const on = path === pane.active;
          const dirty = isDirty(state.files[path]);
          return <Reorder.Item as="div" key={path} value={path} className="handwork-editor-tab" data-active={on || undefined} dragConstraints={strip} dragElastic={0}
            transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT} whileDrag={{ zIndex: 2, boxShadow: '0 6px 16px -6px oklch(0 0 0 / 0.35)' }}
            onDragStart={() => { dragging.current = true; setLayout(layout => ({ ...updatePane(layout, pane.id, { active: path }), focused: pane.id })); }}
            onDragEnd={() => { setTimeout(() => { dragging.current = false; }); }}>
            <button type="button" role="tab" aria-selected={on} title={path} onClick={() => { if (!dragging.current) setLayout(layout => ({ ...updatePane(layout, pane.id, { active: path }), focused: pane.id })); }} onAuxClick={event => { if (event.button === 1) closeTab(pane.id, path); }}><span>{baseName(path)}</span></button>
            <button type="button" className="handwork-editor-tab-close" data-dirty={dirty || undefined} aria-label={dirty ? `Close ${baseName(path)}, unsaved changes` : `Close ${baseName(path)}`} onClick={() => { if (!dragging.current) closeTab(pane.id, path); }}><span className="handwork-editor-dirty" aria-hidden /><X aria-hidden width={12} height={12} /></button>
          </Reorder.Item>;
        })}</Reorder.Group>;
    // Raised into the title row, the tabs and the pane's actions leave the pane without a header.
    const raised = pane.id === mainEditor;
    return <>
      {raised ? <>{tabsHost && createPortal(tabs, tabsHost)}{actionsHost && createPortal(paneActions(pane.id, 'editor'), actionsHost)}</>
        : <div className="handwork-pane-header">{tabs}{paneActions(pane.id, 'editor')}</div>}
      {file && <div className="handwork-editor-bar">
        <span className="handwork-editor-path" title={file.path}>{file.path.split('/').map((part, index, parts) => <span key={index} data-last={index === parts.length - 1 || undefined}>{part}</span>)}</span>
        {file.status === 'ready' && isMarkdown(file.path) && <div className="handwork-view-switch" role="radiogroup" aria-label="Show as">
          {(['source', 'preview'] as const).map(mode => {
            const on = (mode === 'preview') === previewing;
            return <button key={mode} type="button" role="radio" aria-checked={on} data-on={on || undefined}
              onClick={() => setState(current => ({ ...current, previews: mode === 'preview' ? [...new Set([...(current.previews ?? []), file.path])] : (current.previews ?? []).filter(path => path !== file.path) }))}>
              {mode === 'preview' ? 'Preview' : 'Code'}</button>;
          })}
        </div>}
        {file.saving ? <span className="handwork-editor-state"><LoaderCircle aria-hidden width={12} height={12} className="motion-safe:animate-spin" />Saving</span>
          : isDirty(file) ? <Button size="xs" variant="outline" className="handwork-editor-save" onClick={() => void save(file.path)}>Save</Button>
          : file.status === 'ready' ? <span className="handwork-editor-state">Saved</span> : null}
        {support && file.status === 'ready' && <LanguageStatus status={support.status(file.path)} onRestart={() => support.restart(file.path)} />}
      </div>}
      {file?.conflict && <div className="handwork-editor-notice" role="alert">
        <span>{baseName(file.path)} changed on disk since you opened it.</span>
        <Button size="xs" variant="ghost" onClick={() => void reload(file.path)}>Reload</Button>
        <Button size="xs" variant="outline" onClick={() => void save(file.path, true)}>Overwrite</Button>
      </div>}
      {file?.error && <div className="handwork-editor-notice" role="alert" data-error><span>{file.error}</span></div>}
      <ContextMenu.Root disabled={file?.status !== 'ready' || previewing} onOpenChange={open => { if (!open) setEditorMenu(null); }}>
      <ContextMenu.Trigger className="handwork-editor-body" onContextMenuCapture={event => {
        if (file?.status !== 'ready') return;
        const element = event.currentTarget.querySelector('.cm-editor');
        const view = element instanceof HTMLElement ? EditorView.findFromDOM(element) : null;
        setEditorMenu({ paneId: pane.id, path: file.path, selected: !!view && !view.state.selection.main.empty });
      }}>
        {!file ? <div className="handwork-workbench-empty handwork-editor-empty"><File aria-hidden width={22} height={22} /><strong>No file open</strong><span>Choose a file on the left, press {isMac ? '⌘P' : 'Ctrl+P'} to find one by name, or ⌃` for a terminal.</span></div>
          : file.status === 'loading' ? <div className="handwork-workbench-empty">Opening {baseName(file.path)}…</div>
          : file.status === 'binary' ? <div className="handwork-workbench-empty">{baseName(file.path)} is a binary file and can’t be edited here.</div>
          : file.status === 'tooLarge' ? <div className="handwork-workbench-empty">{baseName(file.path)} is larger than 2 MB, too large to edit here.</div>
          : file.status === 'error' ? <div className="handwork-workbench-empty">Could not open {baseName(file.path)}.</div>
          : previewing ? <div className="handwork-markdown-preview" tabIndex={0} aria-label={`${baseName(file.path)}, rendered`}>
            <Markdown className="handwork-file-markdown" syntaxHighlighting syntaxPalette="violet" remarkPlugins={mathPlugins.remarkPlugins} rehypePlugins={mathPlugins.rehypePlugins} components={{
              // Links to the project's own files open here; the web opens in the browser.
              a: ({ href, children }) => <a href={href} onClick={event => {
                if (!href || href.startsWith('#')) return;
                event.preventDefault();
                const target = projectLink(file.path, href);
                if (target) void openFile(target);
                else if (/^https?:/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
              }}>{children}</a>,
            }}>{prepareMath(file.text)}</Markdown>
          </div>
          : <HandworkCodeEditor path={file.path} text={file.text} editable={!file.saving} states={states} base={file.base}
            reveal={reveal?.path === file.path && state.layout.focused === pane.id ? reveal : undefined} onRevealed={() => setReveal(null)}
            cursorOf={path => cursors.get(workspace)?.get(path)} onCursor={(path, cursor, selection) => {
              if (!cursors.has(workspace)) cursors.set(workspace, new Map());
              cursors.get(workspace)!.set(path, cursor);
              selections.current.set(path, selection);
              persistSoon();
              window.clearTimeout(contextTimer.current);
              contextTimer.current = window.setTimeout(() => reportContext.current(), 120);
            }} support={support ? editorSupport : undefined} supportVersion={supportVersion}
            onChange={(path, text) => updateFile(path, { text })} onSave={path => void save(path)} />}
      </ContextMenu.Trigger>
      <MenuPopup align="start" className="handwork-editor-menu">{editorMenu?.paneId === pane.id && editorMenuItems()}</MenuPopup>
      </ContextMenu.Root>
    </>;
  };

  // Each shell is a tab; the others keep running out of sight and are shown as they were left.
  const terminalView = (pane: TerminalPane) => <>
    <div className="handwork-pane-header">
      <div className="handwork-terminal-tabs" role="tablist" aria-label="Terminals">
        {pane.tabs.map((tab, index) => {
          const on = tab.id === pane.active;
          const number = tab.number ?? index + 1;
          const label = `${tab.shell ?? 'Terminal'}${pane.tabs.length > 1 || number > 1 ? ` ${number}` : ''}`;
          return <div key={tab.id} className="handwork-terminal-tab" data-active={on || undefined} data-exited={tab.exited || undefined}>
            <button type="button" role="tab" aria-selected={on} title={tab.exited ? `${label} (exited)` : label}
              onClick={() => setLayout(layout => ({ ...updatePane(layout, pane.id, { active: tab.id }), focused: pane.id }))}
              onAuxClick={event => { if (event.button === 1) closeShell(pane.id, tab.id); }}>
              <SquareTerminal aria-hidden width={13} height={13} /><span>{label}</span>
            </button>
            <button type="button" className="handwork-terminal-tab-close" aria-label={`Close ${label}`} onClick={() => closeShell(pane.id, tab.id)}><X aria-hidden width={12} height={12} /></button>
          </div>;
        })}
        <HoverTooltip content="New terminal (⌃⇧`)"><Button size="icon-sm" variant="ghost" className="handwork-terminal-new" aria-label="New terminal" onClick={() => setLayout(layout => addTerminalTab(layout, pane.id))}><Plus aria-hidden width={14} height={14} /></Button></HoverTooltip>
      </div>
      {paneActions(pane.id, 'terminal')}
    </div>
    <div className="handwork-terminal-body">
      {pane.tabs.map(tab => <div key={tab.id} className="handwork-terminal-shell" hidden={tab.id !== pane.active}>
        {tab.error ? <div className="handwork-workbench-empty">{tab.error}</div>
          : api && <HandworkTerminal api={api} workspace={workspace} terminalId={tab.terminalId} focused={state.layout.focused === pane.id && tab.id === pane.active}
            onOpened={(terminalId, shell) => setLayout(layout => updateTerminalTab(layout, pane.id, tab.id, { terminalId, shell }))}
            onExit={() => setLayout(layout => updateTerminalTab(layout, pane.id, tab.id, { exited: true }))}
            onError={error => setLayout(layout => updateTerminalTab(layout, pane.id, tab.id, { error }))} />}
      </div>)}
    </div>
  </>;

  const render = (node: LayoutNode, depth = 0): ReactNode => {
    if (node.type === 'pane') {
      const pane = state.layout.panes[node.id];
      if (!pane) return null;
      return <section key={pane.id} className="handwork-pane" data-pane={pane.id} data-kind={pane.kind} data-focused={state.layout.focused === pane.id || undefined} aria-label={pane.kind === 'terminal' ? 'Terminal' : 'Editor'}
        onPointerDownCapture={() => { if (stateRef.current.layout.focused !== pane.id) setLayout(layout => ({ ...layout, focused: pane.id })); }}>
        {pane.kind === 'editor' ? editorPane(pane) : terminalView(pane)}
      </section>;
    }
    return <div key={node.id} className="handwork-split" data-direction={node.direction} style={{ gridTemplateColumns: node.direction === 'row' ? `${node.ratio}fr var(--handwork-split-gap, 1px) ${1 - node.ratio}fr` : undefined, gridTemplateRows: node.direction === 'column' ? `${node.ratio}fr var(--handwork-split-gap, 1px) ${1 - node.ratio}fr` : undefined }}>
      {render(node.a, depth + 1)}
      <SplitDivider direction={node.direction} depth={depth} onRatio={ratio => setLayout(layout => setRatio(layout, node.id, ratio))} />
      {render(node.b, depth + 1)}
    </div>;
  };

  if (!workspace) return <div className="handwork-workbench-empty">Open a project to browse its files and run a terminal.</div>;
  const navigation = <nav className="handwork-file-tree" aria-label={sidebar === 'search' ? 'Search in files' : sidebar === 'references' ? 'References' : 'Project files'}>
      <div className="handwork-file-tree-header">
        {sidebar !== 'files' ? <>
          <span className="handwork-file-tree-title"><TextSearch aria-hidden width={14} height={14} />{sidebar === 'references' ? `References to ${references?.symbol ?? ''}` : 'Search'}</span>
          <HoverTooltip content="Show files"><Button size="icon-sm" variant="ghost" aria-label="Show files" onClick={() => setState(current => ({ ...current, sidebar: 'files' }))}><FolderOpen aria-hidden width={14} height={14} /></Button></HoverTooltip>
        </> : <>
          {projects ? <Menu>
            <MenuTrigger render={<button type="button" className="handwork-file-tree-title handwork-project-switch" title={`${workspace} — switch project`} />}>
              <FolderOpen aria-hidden width={14} height={14} /><span>{baseName(workspace)}</span><ChevronDown aria-hidden width={12} height={12} className="handwork-project-switch-chevron" />
            </MenuTrigger>
            <MenuPopup align="start" className="handwork-project-menu">
              <MenuGroup>
              <MenuGroupLabel>Projects</MenuGroupLabel>
              {projects.list.map(project => <MenuItem key={project} title={project} onClick={() => { if (project !== workspace) projects.onSwitch(project); }}>
                <FolderOpen aria-hidden /><span className="handwork-project-menu-name">{baseName(project.replace(/[\\/]+$/, ''))}</span>{project === workspace && <Check aria-hidden className="handwork-project-menu-current" />}
              </MenuItem>)}
              </MenuGroup>
              <MenuSeparator />
              <MenuItem onClick={projects.onOpen}><FolderPlus aria-hidden />Open Folder…<MenuShortcut>{shortcutLabel('Mod+O')}</MenuShortcut></MenuItem>
            </MenuPopup>
          </Menu>
          : <span className="handwork-file-tree-title" title={workspace}><FolderOpen aria-hidden width={14} height={14} />{baseName(workspace)}</span>}
          <HoverTooltip content="New file"><Button size="icon-sm" variant="ghost" aria-label="New file" onClick={() => startCreate('file', '')}><FilePlus aria-hidden width={14} height={14} /></Button></HoverTooltip>
          <HoverTooltip content="New folder"><Button size="icon-sm" variant="ghost" aria-label="New folder" onClick={() => startCreate('directory', '')}><FolderPlus aria-hidden width={14} height={14} /></Button></HoverTooltip>
          <HoverTooltip content={`Search in files (${isMac ? '⌘⇧F' : 'Ctrl+Shift+F'})`}><Button size="icon-sm" variant="ghost" aria-label="Search in files" onClick={showSearch}><TextSearch aria-hidden width={14} height={14} /></Button></HoverTooltip>
          <HoverTooltip content="Refresh files"><Button size="icon-sm" variant="ghost" aria-label="Refresh files" onClick={() => { for (const directory of state.expanded) void loadDirectory(directory); for (const path of Object.keys(state.files)) loadBase(path); }}><RefreshCw aria-hidden width={13} height={13} /></Button></HoverTooltip>
        </>}
        {onClose && <HoverTooltip content="Close files"><Button size="icon-sm" variant="ghost" aria-label="Close files" onClick={onClose}><X aria-hidden width={14} height={14} /></Button></HoverTooltip>}
      </div>
      {sidebar === 'references' ? <div className="handwork-project-search">
          <div className="handwork-project-search-summary" role="status">{references?.matches.length ? `${references.matches.length} ${references.matches.length === 1 ? 'reference' : 'references'} in ${groupMatches(references.matches).length} ${groupMatches(references.matches).length === 1 ? 'file' : 'files'}` : 'No references found in this project.'}</div>
          <div className="handwork-project-search-results" role="tree" aria-label="References">
            <MatchList groups={groupMatches(references?.matches ?? [])} collapsed={references?.collapsed ?? []} onCollapsed={collapsed => setReferences(current => current && { ...current, collapsed })}
              onOpen={(path, line, column, length) => void openFile(path, { line, column, length })} />
          </div>
        </div>
        : sidebar === 'search' ? <HandworkProjectSearch api={api} workspace={workspace} focusToken={searchFocus} onOpen={(path, line, column, length) => void openFile(path, { line, column, length })} />
        : <ContextMenu.Root onOpenChange={open => setMenuOpen(open)}>
          {treeError && <div className="handwork-tree-note" data-error role="alert">{treeError}</div>}
          <ContextMenu.Trigger className="handwork-file-tree-body" role="tree" aria-label={`Files in ${baseName(workspace)}`} onContextMenuCapture={() => setMenuTarget({ path: '', kind: 'directory' })}>{tree('', 0)}</ContextMenu.Trigger>
          <MenuPopup align="start" className="handwork-tree-menu" finalFocus={() => { const keep = !editStarting.current; editStarting.current = false; return keep; }}>
            {menuTarget.kind === 'directory' && <>
              <MenuItem onClick={() => startCreate('file', menuTarget.path)}><FilePlus aria-hidden />New file…</MenuItem>
              <MenuItem onClick={() => startCreate('directory', menuTarget.path)}><FolderPlus aria-hidden />New folder…</MenuItem>
              <MenuSeparator />
            </>}
            {menuTarget.path && <>
              <MenuItem onClick={() => startRename(menuTarget.path)}><Pencil aria-hidden />Rename…</MenuItem>
              <MenuItem variant="destructive" onClick={() => void remove(menuTarget)}><Trash2 aria-hidden />Move to Trash</MenuItem>
              <MenuSeparator />
            </>}
            <MenuItem onClick={() => copyText(absolute(menuTarget.path))}><Copy aria-hidden />Copy path</MenuItem>
            {menuTarget.path && <MenuItem onClick={() => copyText(menuTarget.path)}><Copy aria-hidden />Copy relative path</MenuItem>}
            {api?.revealFile && <MenuItem onClick={() => void api.revealFile(absolute(menuTarget.path)).catch(cause => setTreeError(cleanError(cause)))}><ExternalLink aria-hidden />{isMac ? 'Reveal in Finder' : 'Show in folder'}</MenuItem>}
          </MenuPopup>
        </ContextMenu.Root>}
    </nav>;
  return <div className="handwork-workbench" data-tree={treeHost === undefined ? undefined : 'outside'}>
    {treeHost === undefined ? navigation : treeHost && createPortal(navigation, treeHost)}
    <div className="handwork-panes">{render(state.layout.root)}</div>
    <HandworkQuickOpen open={quickOpen} onOpenChange={setQuickOpen} api={api} workspace={workspace}
      recent={Object.values(state.layout.panes).flatMap(pane => pane.kind === 'editor' ? pane.files : [])} onPick={path => void openFile(path)} />
  </div>;
}

/** A hairline between two panes with a wider grab area; dragging sets the split's ratio. Outer dividers stack above inner ones. */
function SplitDivider({ direction, depth, onRatio }: { direction: 'row' | 'column'; depth: number; onRatio: (ratio: number) => void }) {
  // Where dividers meet in a T, the outer one sits above the inner one's grab area, so it can still be taken.
  return <div className="handwork-split-divider" data-direction={direction} role="separator" aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'} style={{ zIndex: 20 - depth }}
    onPointerDown={event => {
      const parent = event.currentTarget.parentElement;
      if (!parent) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const bounds = parent.getBoundingClientRect();
      const move = (moveEvent: PointerEvent) => onRatio(direction === 'row' ? (moveEvent.clientX - bounds.left) / bounds.width : (moveEvent.clientY - bounds.top) / bounds.height);
      const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); document.body.removeAttribute('data-resizing'); };
      document.body.setAttribute('data-resizing', direction);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
    }} />;
}

/** Typing a name in the tree: Enter or leaving the field keeps it, Escape cancels. */
function TreeNameInput({ kind, depth, initial, error, onCommit, onCancel }: { kind: 'file' | 'directory'; depth: number; initial: string; error?: string; onCommit: (value: string) => void; onCancel: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const field = input.current;
    if (!field) return;
    field.focus();
    // The name is selected without its extension, so typing replaces just the name.
    const dot = kind === 'file' ? initial.lastIndexOf('.') : -1;
    field.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [kind, initial]);
  useEffect(() => { if (error) done.current = false; }, [error]);
  const finish = (cancel: boolean) => {
    if (done.current) return;
    done.current = true;
    if (cancel) onCancel(); else onCommit(input.current?.value ?? '');
  };
  return <div className="handwork-tree-edit" style={{ paddingLeft: 8 + depth * 12 }}>
    <span className="handwork-tree-chevron" aria-hidden />
    {kind === 'directory' ? <Folder className="handwork-tree-icon" aria-hidden /> : <File className="handwork-tree-icon" aria-hidden />}
    <input ref={input} defaultValue={initial} spellCheck={false} autoCapitalize="off" autoComplete="off" aria-label={initial ? `New name for ${initial}` : kind === 'directory' ? 'Folder name' : 'File name'} aria-invalid={!!error || undefined}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); finish(false); } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true); } }}
      onChange={() => { done.current = false; }}
      onBlur={() => finish(!!error && input.current?.value === initial)} />
    {error && <div className="handwork-tree-edit-error" role="alert">{error}</div>}
  </div>;
}

/** Which language server serves the file, and what it is doing; a stopped or missing one says why. */
function LanguageStatus({ status, onRestart }: { status: ServerStatus | null; onRestart: () => void }) {
  if (!status || status.state === 'off') return null;
  if (status.state === 'starting' || (status.state === 'ready' && status.progress)) return <span className="handwork-language-status" role="status" title={status.progress}>
    <LoaderCircle aria-hidden width={11} height={11} className="motion-safe:animate-spin" />{status.state === 'starting' ? `Starting ${status.name}` : status.progress}
  </span>;
  if (status.state === 'ready') return <span className="handwork-language-status" data-state="ready" title={`${status.name} language server: ⌘-click or F12 to go to a definition, ⇧F12 for references, F2 to rename`}><span className="handwork-language-dot" aria-hidden />{status.name}</span>;
  return <HoverTooltip content={status.message ?? `The ${status.name} language server is not running.`}>
    <button type="button" className="handwork-language-status" data-state={status.state} onClick={onRestart}>
      <span className="handwork-language-dot" aria-hidden />{status.state === 'unavailable' ? `No ${status.name} server` : `${status.name} stopped`} · Retry
    </button>
  </HoverTooltip>;
}
