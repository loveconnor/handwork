"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { EditorState } from '@codemirror/state';
import { ChevronRight, File, Folder, FolderOpen, RefreshCw, X, LoaderCircle, Columns2, Rows2, SquareTerminal } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { HoverTooltip } from '@/components/ui/tooltip';
import type { DesktopAPI, ProjectFileEntry } from '@/lib/desktop-api';
import { closeFile, emptyLayout, filesInUse, newId, openInEditor, removePane, setRatio, splitPane, updatePane, type EditorPane, type Layout, type LayoutNode, type TerminalPane } from '@/lib/workbench-layout';
import { HandworkCodeEditor } from './HandworkCodeEditor';
import { HandworkTerminal } from './HandworkTerminal';

type OpenFile = {
  path: string;
  /** The text as edited, and as last loaded or saved, to tell whether it has changes. */
  text: string; saved: string; revision: string | null;
  status: 'loading' | 'ready' | 'binary' | 'tooLarge' | 'error';
  error?: string; conflict?: boolean; saving?: boolean;
};
type WorkbenchState = { layout: Layout; files: Record<string, OpenFile>; expanded: string[] };

/**
 * Each project's workbench outlives the panel: closing it keeps open files,
 * unsaved edits and running terminals, and reopening picks them all back up.
 */
const saved = new Map<string, WorkbenchState>();
const editorStates = new Map<string, Map<string, EditorState>>();

const cleanError = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);
const baseName = (file: string) => file.split('/').pop() || file;
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
  const updateFile = (path: string, change: Partial<OpenFile>) => setState(current => current.files[path] ? { ...current, files: { ...current.files, [path]: { ...current.files[path], ...change } } } : current);

  const openFile = useCallback(async (path: string) => {
    setLayout(layout => openInEditor(layout, path));
    if (stateRef.current.files[path]) return;
    setState(current => ({ ...current, files: { ...current.files, [path]: { path, text: '', saved: '', revision: null, status: 'loading' } } }));
    try {
      const result = await api!.readProjectFile(workspace, path);
      updateFile(path, { status: result.tooLarge ? 'tooLarge' : result.binary ? 'binary' : 'ready', text: result.text ?? '', saved: result.text ?? '', revision: result.revision });
    } catch (cause) { updateFile(path, { status: 'error', error: cleanError(cause) }); }
  }, [api, workspace]);

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
    } catch (cause) { updateFile(path, { error: cleanError(cause) }); }
  };

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
  const tree = (directory: string, depth: number): ReactNode => {
    const listing = directories.get(directory);
    if (!listing || listing === 'loading') return <div className="handwork-tree-note" style={{ paddingLeft: 12 + depth * 12 }}>Loading…</div>;
    if ('error' in listing) return <div className="handwork-tree-note" data-error style={{ paddingLeft: 12 + depth * 12 }}>{listing.error}</div>;
    if (!listing.length) return depth === 0 ? <div className="handwork-tree-note">This project is empty.</div> : null;
    return listing.map(entry => {
      const open = state.expanded.includes(entry.path);
      const current = entry.kind === 'file' && entry.path === activeFile;
      return <div key={entry.path} role="none">
        <button type="button" role="treeitem" aria-level={depth + 1} aria-expanded={entry.kind === 'directory' ? open : undefined} aria-selected={current} className="handwork-tree-row" data-kind={entry.kind} data-current={current || undefined} data-ignored={entry.ignored || undefined} style={{ paddingLeft: 8 + depth * 12 }} title={entry.path}
          onClick={() => entry.kind === 'directory' ? toggleDirectory(entry.path) : void openFile(entry.path)}>
          {entry.kind === 'directory' ? <ChevronRight className="handwork-tree-chevron" data-open={open || undefined} aria-hidden /> : <span className="handwork-tree-chevron" aria-hidden />}
          {entry.kind === 'directory' ? (open ? <FolderOpen className="handwork-tree-icon" aria-hidden /> : <Folder className="handwork-tree-icon" aria-hidden />) : <File className="handwork-tree-icon" aria-hidden />}
          <span className="handwork-tree-name">{entry.name}</span>
        </button>
        {entry.kind === 'directory' && open && <div role="group">{tree(entry.path, depth + 1)}</div>}
      </div>;
    });
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
        <div className="handwork-editor-tabs" role="tablist" aria-label="Open files">{pane.files.map(path => {
          const on = path === pane.active;
          const dirty = isDirty(state.files[path]);
          return <div key={path} className="handwork-editor-tab" data-active={on || undefined}>
            <button type="button" role="tab" aria-selected={on} title={path} onClick={() => setLayout(layout => ({ ...updatePane(layout, pane.id, { active: path }), focused: pane.id }))} onAuxClick={event => { if (event.button === 1) closeTab(pane.id, path); }}><span>{baseName(path)}</span></button>
            <button type="button" className="handwork-editor-tab-close" data-dirty={dirty || undefined} aria-label={dirty ? `Close ${baseName(path)}, unsaved changes` : `Close ${baseName(path)}`} onClick={() => closeTab(pane.id, path)}><span className="handwork-editor-dirty" aria-hidden /><X aria-hidden width={12} height={12} /></button>
          </div>;
        })}</div>
        {paneActions(pane.id, 'editor')}
      </div>
      {file && <div className="handwork-editor-bar">
        <span className="handwork-editor-path" title={file.path}>{file.path.split('/').map((part, index, parts) => <span key={index} data-last={index === parts.length - 1 || undefined}>{part}</span>)}</span>
        {file.saving ? <span className="handwork-editor-state"><LoaderCircle aria-hidden width={12} height={12} className="motion-safe:animate-spin" />Saving</span>
          : isDirty(file) ? <Button size="xs" variant="outline" className="handwork-editor-save" onClick={() => void save(file.path)}>Save</Button>
          : file.status === 'ready' ? <span className="handwork-editor-state">Saved</span> : null}
      </div>}
      {file?.conflict && <div className="handwork-editor-notice" role="alert">
        <span>{baseName(file.path)} changed on disk since you opened it.</span>
        <Button size="xs" variant="ghost" onClick={() => void reload(file.path)}>Reload</Button>
        <Button size="xs" variant="outline" onClick={() => void save(file.path, true)}>Overwrite</Button>
      </div>}
      {file?.error && <div className="handwork-editor-notice" role="alert" data-error><span>{file.error}</span></div>}
      <div className="handwork-editor-body">
        {!file ? <div className="handwork-workbench-empty handwork-editor-empty"><File aria-hidden width={22} height={22} /><strong>No file open</strong><span>Choose a file on the left, or press ⌃` for a terminal.</span></div>
          : file.status === 'loading' ? <div className="handwork-workbench-empty">Opening {baseName(file.path)}…</div>
          : file.status === 'binary' ? <div className="handwork-workbench-empty">{baseName(file.path)} is a binary file and can’t be edited here.</div>
          : file.status === 'tooLarge' ? <div className="handwork-workbench-empty">{baseName(file.path)} is larger than 2 MB, too large to edit here.</div>
          : file.status === 'error' ? <div className="handwork-workbench-empty">Could not open {baseName(file.path)}.</div>
          : <HandworkCodeEditor path={file.path} text={file.text} editable={!file.saving} states={states}
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
    <nav className="handwork-file-tree" aria-label="Project files">
      <div className="handwork-file-tree-header">
        <span className="handwork-file-tree-title" title={workspace}><FolderOpen aria-hidden width={14} height={14} />{baseName(workspace)}</span>
        <HoverTooltip content="Refresh files"><Button size="icon-sm" variant="ghost" aria-label="Refresh files" onClick={() => { for (const directory of state.expanded) void loadDirectory(directory); }}><RefreshCw aria-hidden width={13} height={13} /></Button></HoverTooltip>
        {onClose && <HoverTooltip content="Close files"><Button size="icon-sm" variant="ghost" aria-label="Close files" onClick={onClose}><X aria-hidden width={14} height={14} /></Button></HoverTooltip>}
      </div>
      <div className="handwork-file-tree-body" role="tree" aria-label={`Files in ${baseName(workspace)}`}>{tree('', 0)}</div>
    </nav>
    <div className="handwork-panes">{render(state.layout.root)}</div>
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
