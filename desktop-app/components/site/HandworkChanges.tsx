"use client";

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { HoverTooltip } from "@/components/ui/tooltip";
import { ResizeHandle, useStoredSize } from '@/components/site/HandworkResizeHandle';
import { Button } from '@/components/ui/button';
import { ChevronDown, FileDiff, Minus, Plus } from 'honestui/icons';
import { ChangeCounts, DEFAULT_CONTEXT, DiffControls, DiffSections, StatusBadge, splitPath } from '@/components/site/HandworkDiff';
import { CommitComposer, GitHistory, GitNoticeView, RepositoryHeader, type CommitWriting } from '@/components/site/HandworkGit';
import type { DesktopAPI, GitAction, GitChange, GitRepositoryState, ProjectChangesSnapshot, ProjectFileDiff } from '@/lib/desktop-api';
import { changeStatus, plural } from '@/lib/git-format';
import { errorText, useGitRepository, type GitRepository } from '@/lib/use-git-repository';

export { ChangeCounts };

type Area = 'conflict' | 'staged' | 'unstaged';
type Repository = Extract<GitRepositoryState, { kind: 'repository' }>;
const GROUPS: { area: Area; title: string }[] = [{ area: 'conflict', title: 'Merge conflicts' }, { area: 'staged', title: 'Staged changes' }, { area: 'unstaged', title: 'Unstaged' }];
const changesIn = (state: Repository, area: Area) => area === 'staged' ? state.staged : area === 'unstaged' ? state.unstaged : state.conflicts;
const diffArea = (area: Area) => area === 'staged' ? 'staged' : 'unstaged';

function areaDescription(change: GitChange, area: Area) {
  if (area === 'conflict') return 'Merge conflict';
  if (change.untracked) return 'Untracked';
  if (change.partial) return area === 'staged' ? 'Staged · partial' : 'Unstaged · partial';
  return area === 'staged' ? 'Staged' : 'Unstaged';
}

export function ChangesTrigger({ open, fileCount, added, removed, onClick }: {
  open: boolean; fileCount: number; added?: number; removed?: number; onClick: () => void;
}) {
  const showTotals = fileCount > 0 && added !== undefined && removed !== undefined;
  const description = `Changes${showTotals ? `, ${added} added lines, ${removed} removed lines` : ''}`;
  return <Button id="handwork-changes-trigger" className="handwork-changes-trigger" size="sm" variant="ghost" aria-label={description} title={description} aria-expanded={open} aria-controls={open ? 'handwork-review-panel' : undefined} onClick={onClick}>
    <FileDiff className="handwork-changes-icon" aria-hidden strokeWidth={1.5} />
    <span className="handwork-changes-label">Changes</span>
    {showTotals && <span className="handwork-changes-totals" aria-hidden><ChangeCounts added={added} removed={removed} /></span>}
  </Button>;
}

function ChangeRow({ change, area, scoped, selected, busy, onSelect, onToggle }: {
  change: GitChange; area: Area; scoped: boolean; selected: boolean; busy: boolean; onSelect: () => void; onToggle: () => void;
}) {
  const { name, directory } = splitPath(change.path);
  const status = changeStatus(change);
  const action = area === 'staged' ? 'Unstage' : area === 'conflict' ? 'Mark resolved' : 'Stage';
  return <li className="handwork-change-row" aria-current={selected ? 'true' : undefined}>
    <HoverTooltip content={change.path}><button type="button" className="handwork-change-select" aria-label={`${change.path}, ${status}, ${areaDescription(change, area)}`} aria-controls="handwork-file-diff" aria-current={selected ? 'true' : undefined} onClick={onSelect}>
      <StatusBadge status={status} />
      <span className="handwork-change-path"><span className="handwork-change-filename">{name}</span>{directory && <span className="handwork-change-directory">{directory}</span>}</span>
      {change.partial && <span className="handwork-change-tag">Partial</span>}
      {scoped && !change.inProject && <span className="handwork-change-tag" data-kind="outside">Outside project</span>}
      {change.binary ? <span className="handwork-change-meta">Binary</span> : change.complete ? <ChangeCounts added={change.added} removed={change.removed} /> : <span className="handwork-change-meta" aria-label="Line counts unavailable">—</span>}
    </button></HoverTooltip>
    <HoverTooltip content={area === 'conflict' ? 'Stage this file once its conflicts are resolved' : action}><Button className="handwork-change-action" size="icon-sm" variant="ghost" aria-label={`${action} ${change.path}`} disabled={busy} onClick={onToggle}>
      {area === 'staged' ? <Minus size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
    </Button></HoverTooltip>
  </li>;
}

function WorkingChanges({ api, workspace, state, git, ...writing }: { api: DesktopAPI; workspace: string; state: Repository; git: GitRepository } & CommitWriting) {
  const [selected, setSelected] = useState<{ area: Area; path: string }>();
  const [detail, setDetail] = useState<ProjectFileDiff>();
  const [diffError, setDiffError] = useState('');
  const [collapsed, setCollapsed] = useState<Partial<Record<Area, boolean>>>({});
  const [wrap, setWrap] = useState(false);
  const [contexts, setContexts] = useState<Record<string, number>>({});
  const [listHeight, setListHeight] = useStoredSize('handwork.changedFilesHeight.v2');
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const items = GROUPS.flatMap(({ area }) => changesIn(state, area).map(change => ({ area, change })));
  // A staged or unstaged file keeps its selection as it moves between groups.
  const current = items.find(item => item.area === selected?.area && item.change.path === selected.path) ?? items.find(item => item.change.path === selected?.path) ?? items[0];
  const key = current ? `${current.area}:${current.change.path}` : '';
  const context = contexts[key] ?? DEFAULT_CONTEXT;
  const setContext = (value: number) => { if (key) setContexts(values => ({ ...values, [key]: value })); };
  useEffect(() => {
    let cancelled = false;
    if (!current) { setDetail(undefined); return; }
    setDiffError('');
    api.gitFileDiff(workspace, current.change.path, diffArea(current.area), context)
      .then(value => { if (!cancelled) setDetail(value); })
      .catch(cause => { if (!cancelled) setDiffError(errorText(cause)); });
    return () => { cancelled = true; };
    // The diff follows every status refresh, so it never trails what will be committed.
  }, [api, workspace, key, context, state.checkedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const container = list.current;
    if (!container) return;
    const revealSelection = () => {
      const row = container.querySelector<HTMLElement>('.handwork-change-row[aria-current="true"]');
      if (!row) return;
      const viewport = container.getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      const header = row.closest('section')?.querySelector('.handwork-change-group-header')?.getBoundingClientRect().height ?? 0;
      if (bounds.top < viewport.top + header) container.scrollTop -= viewport.top + header - bounds.top;
      else if (bounds.bottom > viewport.bottom) container.scrollTop += bounds.bottom - viewport.bottom;
    };
    revealSelection();
    const observer = new ResizeObserver(revealSelection);
    observer.observe(container);
    return () => observer.disconnect();
  }, [key, listHeight]);
  const busy = !!git.busy;
  const stage = (paths: string[]) => void git.run('stage', () => api.gitStage(workspace, paths));
  const unstage = (paths: string[]) => void git.run('unstage', () => api.gitUnstage(workspace, paths));
  const composer = <CommitComposer {...writing} key={state.repository} api={api} workspace={workspace} state={state} git={git} />;
  if (!current) return <>
    {state.operation === 'merge' && composer}
    <div className="handwork-changes-clean"><FileDiff aria-hidden strokeWidth={1.5} /><p>No uncommitted changes</p><span>{(state.push?.outgoing || state.publish?.outgoing) ? 'Your commits are ready to push.' : `Edits to ${state.name} will show up here.`}</span></div>
  </>;
  const currentDetail = detail?.path === current.change.path && detail.area === diffArea(current.area) ? detail : undefined;
  const { name, directory } = splitPath(current.change.path);
  const index = items.indexOf(current);
  const status = changeStatus(current.change);
  return <div ref={container} className="handwork-working" data-sized={listHeight ? '' : undefined} style={listHeight ? { '--handwork-files-height': `${listHeight}px` } as CSSProperties : undefined}>
    {composer}
    <nav ref={list} id="handwork-changed-files" aria-label="Changed files" className="handwork-changed-files handwork-change-groups">
      {state.truncated && <p className="handwork-changes-note">Showing the first 1,000 of {state.totalFiles.toLocaleString()} changed files.</p>}
      {GROUPS.map(({ area, title }) => {
        const changes = changesIn(state, area);
        if (!changes.length) return null;
        const open = !collapsed[area];
        return <section key={area} className="handwork-change-group" data-area={area} aria-label={title}>
          <div className="handwork-change-group-header">
            <button type="button" className="handwork-change-group-toggle" aria-expanded={open} onClick={() => setCollapsed(value => ({ ...value, [area]: open }))}>
              <ChevronDown className="handwork-changes-chevron" aria-hidden strokeWidth={1.75} />
              <span>{title}</span><span className="handwork-change-group-count">{changes.length.toLocaleString()}</span>
            </button>
            {area === 'staged' && changes.length > 0 && <Button size="xs" variant="ghost" disabled={busy} onClick={() => void git.run('unstage', () => api.gitUnstageAll(workspace))}>Unstage all</Button>}
            {area === 'unstaged' && <HoverTooltip content={state.scope ? `Stages every change in ${state.name}, including outside ${state.scope}` : undefined}><Button size="xs" variant="ghost" disabled={busy} onClick={() => void git.run('stage', () => api.gitStageAll(workspace))}>Stage all</Button></HoverTooltip>}
          </div>
          {open && (changes.length
            ? <ul className="handwork-change-list">{changes.map(change => <ChangeRow key={change.path} change={change} area={area} scoped={!!state.scope} busy={busy}
              selected={current.area === area && current.change.path === change.path}
              onSelect={() => setSelected({ area, path: change.path })}
              onToggle={() => area === 'staged' ? unstage([change.path]) : stage([change.path])} />)}</ul>
            : <p className="handwork-change-group-empty">Stage files to include them in the next commit.</p>)}
        </section>;
      })}
    </nav>
    <ResizeHandle className="handwork-files-resize" orientation="horizontal" direction={1} label="Resize file list" min={56}
      max={() => (container.current?.clientHeight ?? 600) - 160}
      measure={() => list.current?.getBoundingClientRect().height} onResize={setListHeight} />
    <div key={key} id="handwork-file-diff" className="handwork-file-review" role="region" aria-label={`Changes to ${current.change.path}`} tabIndex={0}>
      <header className="handwork-file-review-header">
        <div className="handwork-file-review-title">
          <HoverTooltip content={current.change.path}><h3>{name}</h3></HoverTooltip>
          <p><span className="handwork-file-review-status" data-status={status}>{status}</span>{directory && <> · {directory}</>} · {areaDescription(current.change, current.area)}</p>
        </div>
        {current.change.complete && !current.change.binary && <ChangeCounts added={current.change.added} removed={current.change.removed} />}
        <div className="handwork-file-review-actions">
          <Button className="handwork-file-review-stage" size="xs" variant="outline" disabled={busy}
            onClick={() => current.area === 'staged' ? unstage([current.change.path]) : stage([current.change.path])}>{current.area === 'staged' ? 'Unstage' : current.area === 'conflict' ? 'Mark resolved' : 'Stage'}</Button>
          <DiffControls context={context} onContext={setContext} wrap={wrap} onWrap={() => setWrap(value => !value)} canFold={!current.change.untracked && !current.change.binary}
            index={index} count={items.length} onStep={offset => { const next = items[index + offset]; if (next) setSelected({ area: next.area, path: next.change.path }); }} />
        </div>
      </header>
      <DiffSections detail={currentDetail} error={diffError} path={current.change.path} wrap={wrap} context={context} onContext={setContext} />
    </div>
  </div>;
}

export default function HandworkChanges({ api, workspace, snapshot, loading, error, onChanged, ...writing }: {
  api?: DesktopAPI; workspace: string; snapshot?: ProjectChangesSnapshot; loading: boolean; error?: string; onChanged?: () => void;
} & CommitWriting) {
  const git = useGitRepository(api, workspace, snapshot?.checkedAt, onChanged);
  const [view, setView] = useState<'changes' | 'history'>('changes');
  const [pickerOpen, setPickerOpen] = useState(false);
  if (!workspace) return <p className="handwork-changes-empty">Select a project to see its changes.</p>;
  if (!api) return <p className="handwork-changes-empty">Open the desktop app to review project changes.</p>;
  const state = git.state;
  if (!state) return (git.loadError || error)
    ? <p role="alert" className="handwork-changes-empty">{git.loadError || error}</p>
    : <p role="status" className="handwork-changes-empty">{loading ? 'Reading project changes…' : 'Reading the repository…'}</p>;
  if (state.kind !== 'repository') return <p className="handwork-changes-empty">{state.kind === 'not-repository' ? 'This project is not a Git repository.' : 'Select a project to see its changes.'}</p>;
  const terminal = () => void api.gitOpenTerminal(workspace).catch(cause => git.setNotice({ kind: 'error', operation: 'commit', failure: { code: 'terminal', title: 'Couldn’t open a terminal', message: errorText(cause), actions: [] } }));
  const onAction = (action: GitAction) => {
    const notice = git.notice;
    if (action === 'retry' && notice?.kind === 'error') notice.retry?.();
    else if (action === 'terminal') terminal();
    else if (action === 'refresh') { git.setNotice(undefined); void git.refresh(); }
    else if (action === 'fetch') void git.run('fetch', () => api.gitFetch(workspace), () => 'Fetched the latest remote changes.');
    else if (action === 'pull') void git.run('pull', () => api.gitPull(workspace), () => `Pulled from ${state.upstream?.name}.`);
    else if (action === 'branch') setPickerOpen(true);
    else if (action === 'publish') {
      if (state.remotes.length === 1) void git.run('publish', () => api.gitPublish(workspace, state.remotes[0].name), result => `Published ${result.destination} and set it as upstream.`);
      else document.getElementById('handwork-publish')?.focus();
    }
  };
  const outgoing = state.push?.outgoing ?? state.publish?.outgoing ?? 0;
  const total = new Set([...state.staged, ...state.unstaged, ...state.conflicts].map(change => change.path)).size;
  return <div className="handwork-changes handwork-git">
    <RepositoryHeader api={api} workspace={workspace} state={state} git={git} pickerOpen={pickerOpen} onPickerOpen={setPickerOpen} onTerminal={terminal} />
    {git.loadError && <p role="alert" className="handwork-git-stale">{git.loadError} The status may be out of date.</p>}
    {git.notice && <GitNoticeView notice={git.notice} onAction={onAction} onDismiss={() => git.setNotice(undefined)} />}
    <div role="tablist" aria-label="Repository views" className="handwork-changes-tabs">
      <button type="button" role="tab" id="handwork-changes-tab" aria-selected={view === 'changes'} aria-controls="handwork-changes-view" onClick={() => setView('changes')}>
        Files{total > 0 && <span className="handwork-changes-tab-count" aria-label={plural(total, 'changed file')}>{total.toLocaleString()}</span>}
      </button>
      <button type="button" role="tab" id="handwork-history-tab" aria-selected={view === 'history'} aria-controls="handwork-changes-view" onClick={() => setView('history')}>
        History{outgoing > 0 && <span className="handwork-changes-tab-count" data-kind="outgoing" aria-label={`${plural(outgoing, 'commit')} not pushed`}>↑{outgoing.toLocaleString()}</span>}
      </button>
    </div>
    <div id="handwork-changes-view" role="tabpanel" aria-labelledby={view === 'changes' ? 'handwork-changes-tab' : 'handwork-history-tab'} className="handwork-changes-view">
      {view === 'changes'
        ? <WorkingChanges {...writing} key={state.repository} api={api} workspace={workspace} state={state} git={git} />
        : <GitHistory key={state.repository} api={api} workspace={workspace} state={state} />}
    </div>
  </div>;
}
