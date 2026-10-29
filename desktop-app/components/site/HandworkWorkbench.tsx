"use client";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { EditorState } from '@codemirror/state';
import { Reorder, useReducedMotion } from 'motion/react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { ChevronRight, Copy, File, FilePlus, Folder, FolderOpen, FolderPlus, RefreshCw, X, LoaderCircle, Columns2, Rows2, Search, SquareTerminal, TextSearch, Pencil, Trash2, ExternalLink } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { HoverTooltip } from '@/components/ui/tooltip';
import { MenuItem, MenuPopup, MenuSeparator } from '@/components/ui/menu';
import type { DesktopAPI, ProjectFileEntry, ProjectSearchMatch } from '@/lib/desktop-api';
import { closeFile, closeWithin, emptyLayout, filesInUse, isWithin, movedPath, newId, openInEditor, removePane, renameInLayout, setRatio, splitPane, updatePane, type EditorPane, type Layout, type LayoutNode, type TerminalPane } from '@/lib/workbench-layout';
import { HandworkCodeEditor, type EditorReveal } from './HandworkCodeEditor';
import { HandworkTerminal } from './HandworkTerminal';
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
type WorkbenchState = { layout: Layout; files: Record<string, OpenFile>; expanded: string[]; sidebar?: 'files' | 'search' | 'references' };
/** A name being typed in the tree: a new file or folder inside `parent`, or a new name for `path`. */
type TreeEdit = { kind: 'file' | 'directory'; parent: string; error?: string } | { kind: 'rename'; path: string; error?: string };
/** What a right-click in the tree acts on; '' is the project root. */
type MenuTarget = { path: string; kind: 'file' | 'directory' };

/**
 * Each project's workbench outlives the panel: closing it keeps open files,
 * unsaved edits and running terminals, and reopening picks them all back up.
 */
const saved = new Map<string, WorkbenchState>();
const editorStates = new Map<string, Map<string, EditorState>>();
/** The open project's language servers; they outlive the panel, and stop when another project is opened. */
let languages: LanguageSupport | null = null;

const cleanError = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);
const baseName = (file: string) => file.split('/').pop() || file;
const parentOf = (file: string) => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
const joinPath = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const isDirty = (file?: OpenFile) => !!file && file.status === 'ready' && file.text !== file.saved;

export type WorkbenchRequest = { kind: 'terminal' | 'file'; path?: string; at: number };

/**
 * The project's files and shells beside the chat: a tree to browse, and panes
 * that split side by side or stacked, each an editor with tabs or a terminal.
 * Saving checks the file has not changed on disk since it was opened, so an
 * agent's edit is never overwritten without asking.
 */
export function HandworkWorkbench({ api, workspace, request, onClose }: { api?: DesktopAPI; workspace: string; request?: WorkbenchRequest; onClose?: () => void }) {
  const [state, setState] = useState<WorkbenchState>(() => saved.get(workspace) ?? { layout: emptyLayout(), files: {}, expanded: [''] });
  const [directories, setDirectories] = useState<Map<string, ProjectFileEntry[] | 'loading' | { error: string }>>(new Map());
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => { saved.set(workspace, state); }, [workspace, state]);

  const loadDirectory = useCallback(async (directory: string) => {
    if (!api?.listProjectFiles || !workspace) return;
    setDirectories(current => new Map(current).set(directory, 'loading'));
    try { const result = await api.listProjectFiles(workspace, directory); setDirectories(current => new Map(current).set(directory, result.entries)); }
    catch (cause) { setDirectories(current => new Map(current).set(directory, { error: cleanError(cause) })); }
  }, [api, workspace]);

  // Another project brings its own workbench, as it was left.
  useEffect(() => {
    const next = saved.get(workspace) ?? { layout: emptyLayout(), files: {}, expanded: [''] };
    setState(next);
    setDirectories(new Map());
    if (workspace) for (const directory of next.expanded) void loadDirectory(directory);
  }, [workspace, loadDirectory]);

  const setLayout = (change: (layout: Layout) => Layout) => setState(current => ({ ...current, layout: change(current.layout) }));
  const reduceMotion = useReducedMotion();
  // A drag ends with a click on whatever is under the pointer; that click must not close or switch tabs.
  const dragging = useRef(false);
  const updateFile = (path: string, change: Partial<OpenFile>) => setState(current => current.files[path] ? { ...current, files: { ...current.files, [path]: { ...current.files[path], ...change } } } : current);

  const loadBase = useCallback((path: string) => {
    if (!api?.projectFileBase) return;
    // Change bars are a nicety; without git they are simply not shown.
    api.projectFileBase(workspace, path).then(result => updateFile(path, { base: result.text })).catch(() => {});
  }, [api, workspace]);

  // Where the next opened file puts its cursor, from a search result.
  const [reveal, setReveal] = useState<(EditorReveal & { path: string }) | null>(null);
  const revealToken = useRef(0);
  const openFile = useCallback(async (path: string, at?: Omit<EditorReveal, 'token'>) => {
    setLayout(layout => openInEditor(layout, path));
    if (at) setReveal({ path, ...at, token: ++revealToken.current });
    if (stateRef.current.files[path]) return;
    setState(current => ({ ...current, files: { ...current.files, [path]: { path, text: '', saved: '', revision: null, status: 'loading' } } }));
    try {
      const result = await api!.readProjectFile(workspace, path);
      updateFile(path, { status: result.tooLarge ? 'tooLarge' : result.binary ? 'binary' : 'ready', text: result.text ?? '', saved: result.text ?? '', revision: result.revision });
      if (!result.tooLarge && !result.binary) loadBase(path);
    } catch (cause) { updateFile(path, { status: 'error', error: cleanError(cause) }); }
  }, [api, workspace, loadBase]);

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
    if (languages?.workspace !== workspace) {
      languages?.dispose();
      languages = new LanguageSupport(api, workspace, { open: path => languageHooks.current.open(path), edit: (path, change) => languageHooks.current.edit(path, change), references: (symbol, matches) => languageHooks.current.references(symbol, matches) });
    }
    setSupport(languages);
    return languages.subscribe(() => setSupportVersion(count => count + 1));
  }, [api, workspace]);
  const editorSupport = useCallback((path: string) => support!.support(path), [support]);

  const newTerminal = useCallback((from?: string, direction?: 'row' | 'column') => setLayout(layout => {
    const target = from ?? layout.focused;
    const pane: TerminalPane = { id: newId('pane'), kind: 'terminal' };
    // Below an editor by default, beside another terminal.
    return splitPane(layout, target, pane, direction ?? (layout.panes[target]?.kind === 'terminal' ? 'row' : 'column'), direction ? 0.5 : 0.6);
  }), []);

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
    if (pane?.kind === 'terminal' && pane.terminalId) void api?.closeTerminal(pane.terminalId).catch(() => {});
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
    if (request.kind === 'file' && request.path) void openFile(request.path);
    if (request.kind === 'terminal') {
      const existing = Object.values(stateRef.current.layout.panes).find(pane => pane.kind === 'terminal' && !pane.exited);
      if (existing) setLayout(layout => ({ ...layout, focused: existing.id })); else newTerminal();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);


  const toggleDirectory = (directory: string) => {
    const open = state.expanded.includes(directory);
    setState(current => ({ ...current, expanded: open ? current.expanded.filter(item => item !== directory) : [...current.expanded, directory] }));
    if (!open && !directories.has(directory)) void loadDirectory(directory);
  };

  const focusedPane = state.layout.panes[state.layout.focused];
  const activeFile = focusedPane?.kind === 'editor' ? focusedPane.active : undefined;
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

  const editorPane = (pane: EditorPane) => {
    const file = pane.active ? state.files[pane.active] : undefined;
    let states = editorStates.get(pane.id);
    if (!states) editorStates.set(pane.id, states = new Map());
    return <>
      <div className="handwork-pane-header">
        <Reorder.Group as="div" axis="x" layoutScroll values={pane.files} onReorder={files => setLayout(layout => updatePane(layout, pane.id, { files }))} className="handwork-editor-tabs" role="tablist" aria-label="Open files">{pane.files.map(path => {
          const on = path === pane.active;
          const dirty = isDirty(state.files[path]);
          return <Reorder.Item as="div" key={path} value={path} className="handwork-editor-tab" data-active={on || undefined}
            transition={reduceMotion ? { duration: 0 } : SPRING_LAYOUT} whileDrag={{ zIndex: 2, boxShadow: '0 6px 16px -6px oklch(0 0 0 / 0.35)' }}
            onDragStart={() => { dragging.current = true; setLayout(layout => ({ ...updatePane(layout, pane.id, { active: path }), focused: pane.id })); }}
            onDragEnd={() => { setTimeout(() => { dragging.current = false; }); }}>
            <button type="button" role="tab" aria-selected={on} title={path} onClick={() => { if (!dragging.current) setLayout(layout => ({ ...updatePane(layout, pane.id, { active: path }), focused: pane.id })); }} onAuxClick={event => { if (event.button === 1) closeTab(pane.id, path); }}><span>{baseName(path)}</span></button>
            <button type="button" className="handwork-editor-tab-close" data-dirty={dirty || undefined} aria-label={dirty ? `Close ${baseName(path)}, unsaved changes` : `Close ${baseName(path)}`} onClick={() => { if (!dragging.current) closeTab(pane.id, path); }}><span className="handwork-editor-dirty" aria-hidden /><X aria-hidden width={12} height={12} /></button>
          </Reorder.Item>;
        })}</Reorder.Group>
        {paneActions(pane.id, 'editor')}
      </div>
      {file && <div className="handwork-editor-bar">
        <span className="handwork-editor-path" title={file.path}>{file.path.split('/').map((part, index, parts) => <span key={index} data-last={index === parts.length - 1 || undefined}>{part}</span>)}</span>
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
      <div className="handwork-editor-body">
        {!file ? <div className="handwork-workbench-empty handwork-editor-empty"><File aria-hidden width={22} height={22} /><strong>No file open</strong><span>Choose a file on the left, press {isMac ? '⌘P' : 'Ctrl+P'} to find one by name, or ⌃` for a terminal.</span></div>
          : file.status === 'loading' ? <div className="handwork-workbench-empty">Opening {baseName(file.path)}…</div>
          : file.status === 'binary' ? <div className="handwork-workbench-empty">{baseName(file.path)} is a binary file and can’t be edited here.</div>
          : file.status === 'tooLarge' ? <div className="handwork-workbench-empty">{baseName(file.path)} is larger than 2 MB, too large to edit here.</div>
          : file.status === 'error' ? <div className="handwork-workbench-empty">Could not open {baseName(file.path)}.</div>
          : <HandworkCodeEditor path={file.path} text={file.text} editable={!file.saving} states={states} base={file.base}
            reveal={reveal?.path === file.path && state.layout.focused === pane.id ? reveal : undefined} onRevealed={() => setReveal(null)} support={support ? editorSupport : undefined} supportVersion={supportVersion}
            onChange={(path, text) => updateFile(path, { text })} onSave={path => void save(path)} />}
      </div>
    </>;
  };

  const terminalPane = (pane: TerminalPane) => <>
    <div className="handwork-pane-header">
      <span className="handwork-pane-title"><SquareTerminal aria-hidden width={13} height={13} />{pane.shell ?? 'Terminal'}{pane.exited && <span className="handwork-pane-note">exited</span>}</span>
      {paneActions(pane.id, 'terminal')}
    </div>
    <div className="handwork-terminal-body">
      {pane.error ? <div className="handwork-workbench-empty">{pane.error}</div>
        : api && <HandworkTerminal key={pane.id} api={api} workspace={workspace} terminalId={pane.terminalId} focused={state.layout.focused === pane.id}
          onOpened={(terminalId, shell) => setLayout(layout => updatePane(layout, pane.id, { terminalId, shell }))}
          onExit={() => setLayout(layout => updatePane(layout, pane.id, { exited: true }))}
          onError={error => setLayout(layout => updatePane(layout, pane.id, { error }))} />}
    </div>
  </>;

  const render = (node: LayoutNode, depth = 0): ReactNode => {
    if (node.type === 'pane') {
      const pane = state.layout.panes[node.id];
      if (!pane) return null;
      return <section key={pane.id} className="handwork-pane" data-kind={pane.kind} data-focused={state.layout.focused === pane.id || undefined} aria-label={pane.kind === 'terminal' ? 'Terminal' : 'Editor'}
        onPointerDownCapture={() => { if (stateRef.current.layout.focused !== pane.id) setLayout(layout => ({ ...layout, focused: pane.id })); }}>
        {pane.kind === 'editor' ? editorPane(pane) : terminalPane(pane)}
      </section>;
    }
    return <div key={node.id} className="handwork-split" data-direction={node.direction} style={{ gridTemplateColumns: node.direction === 'row' ? `${node.ratio}fr 1px ${1 - node.ratio}fr` : undefined, gridTemplateRows: node.direction === 'column' ? `${node.ratio}fr 1px ${1 - node.ratio}fr` : undefined }}>
      {render(node.a, depth + 1)}
      <SplitDivider direction={node.direction} depth={depth} onRatio={ratio => setLayout(layout => setRatio(layout, node.id, ratio))} />
      {render(node.b, depth + 1)}
    </div>;
  };

  if (!workspace) return <div className="handwork-workbench-empty">Open a project to browse its files and run a terminal.</div>;
  return <div className="handwork-workbench">
    <nav className="handwork-file-tree" aria-label={sidebar === 'search' ? 'Search in files' : sidebar === 'references' ? 'References' : 'Project files'}>
      <div className="handwork-file-tree-header">
        {sidebar !== 'files' ? <>
          <span className="handwork-file-tree-title"><TextSearch aria-hidden width={14} height={14} />{sidebar === 'references' ? `References to ${references?.symbol ?? ''}` : 'Search'}</span>
          <HoverTooltip content="Show files"><Button size="icon-sm" variant="ghost" aria-label="Show files" onClick={() => setState(current => ({ ...current, sidebar: 'files' }))}><FolderOpen aria-hidden width={14} height={14} /></Button></HoverTooltip>
        </> : <>
          <span className="handwork-file-tree-title" title={workspace}><FolderOpen aria-hidden width={14} height={14} />{baseName(workspace)}</span>
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
    </nav>
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
