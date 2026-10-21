"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, CircleAlert, FolderGit2, GitBranch, GitBranchPlus, Info, LoaderCircle, Plus, Search, Sparkles, SquareTerminal, TriangleAlert, Undo2, X } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { HoverTooltip } from '@/components/ui/tooltip';
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from '@/components/ui/menu';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { ResizeHandle, useStoredSize } from '@/components/site/HandworkResizeHandle';
import { ChangeCounts, DEFAULT_CONTEXT, DiffControls, DiffSections, StatusBadge, splitPath } from '@/components/site/HandworkDiff';
import type { DesktopAPI, GitAction, GitBranch as Branch, GitCommitDetails, GitCommitSummary, GitLog, GitRepositoryState, ProjectFileDiff } from '@/lib/desktop-api';
import { changeStatus, draftKey, operationLabel, plural, relativeTime, reviewedCommit } from '@/lib/git-format';
import { errorText, type GitNotice, type GitRepository } from '@/lib/use-git-repository';

type Repository = Extract<GitRepositoryState, { kind: 'repository' }>;
const NETWORK = ['push', 'publish', 'fetch', 'pull'];
const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function Spinner() {
  return <LoaderCircle className="handwork-git-spinner motion-safe:animate-spin" aria-hidden size={13} strokeWidth={1.75} />;
}

export function RepositoryHeader({ state, git, api, workspace, pickerOpen, onPickerOpen, onTerminal }: {
  state: Repository; git: GitRepository; api: DesktopAPI; workspace: string; pickerOpen: boolean; onPickerOpen: (open: boolean) => void; onTerminal: () => void;
}) {
  return <div className="handwork-repo">
    <div className="handwork-repo-row">
      <FolderGit2 className="handwork-repo-icon" aria-hidden size={14} strokeWidth={1.5} />
      <HoverTooltip content={state.repository}><span className="handwork-repo-name">{state.name}</span></HoverTooltip>
      {state.scope && <HoverTooltip content={`Selected project folder: ${state.scope}`}><span className="handwork-repo-scope">/ {state.scope}</span></HoverTooltip>}
      <HoverTooltip content="Open terminal in repository"><Button className="handwork-repo-terminal" size="icon-sm" variant="ghost" aria-label="Open terminal in repository" onClick={onTerminal}><SquareTerminal size={14} aria-hidden /></Button></HoverTooltip>
    </div>
    <div className="handwork-repo-context">
      <BranchPicker api={api} workspace={workspace} state={state} git={git} open={pickerOpen} onOpenChange={onPickerOpen} />
      <SyncBar api={api} workspace={workspace} state={state} git={git} />
    </div>
    {state.scope && <p className="handwork-repo-note"><Info aria-hidden size={13} strokeWidth={1.75} /><span>Showing all of <strong>{state.name}</strong>. Your project is <strong>{state.scope}</strong>, but a commit includes every staged change in the repository.</span></p>}
    {state.operation && <p className="handwork-repo-note" data-tone="warning"><TriangleAlert aria-hidden size={13} strokeWidth={1.75} /><span>A {state.operation} is in progress. Resolve conflicts in your editor or a terminal, then stage the files.</span></p>}
  </div>;
}

function BranchPicker({ api, workspace, state, git, open, onOpenChange }: {
  api: DesktopAPI; workspace: string; state: Repository; git: GitRepository; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const [branches, setBranches] = useState<Branch[]>();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useId();
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setQuery(''); setActive(0); setError('');
    api.gitBranches(workspace).then(result => { if (!cancelled) setBranches(result.branches); }).catch(cause => { if (!cancelled) setError(errorText(cause)); });
    return () => { cancelled = true; };
  }, [api, workspace, open, state.head.branch]);
  const name = query.trim().replace(/\s+/g, '-');
  const filtered = (branches ?? []).filter(branch => branch.name.toLowerCase().includes(query.trim().toLowerCase()));
  const canCreate = !!name && !(branches ?? []).some(branch => branch.name === name);
  const options = [...filtered.map(branch => ({ kind: 'branch' as const, branch })), ...(canCreate ? [{ kind: 'create' as const, name }] : [])];
  const choose = (option: (typeof options)[number] | undefined) => {
    if (!option) return;
    onOpenChange(false);
    if (option.kind === 'create') void git.run('branch', () => api.gitCreateBranch(workspace, option.name), () => `Created ${option.name} from ${state.head.branch ?? 'the current commit'} and switched to it.`);
    else if (!option.branch.current) void git.run('switch', () => api.gitSwitchBranch(workspace, option.branch.name), () => `Switched to ${option.branch.name}.`);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(index => options.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length : 0);
    } else if (event.key === 'Enter') { event.preventDefault(); choose(options[Math.min(active, options.length - 1)]); }
  };
  useEffect(() => { document.getElementById(`${list}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, list]);
  const dirty = state.staged.length + state.unstaged.length > 0;
  const label = state.head.branch ?? (state.head.oid ? `Detached at ${state.head.oid.slice(0, 7)}` : 'No branch');
  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger render={<Button className="handwork-branch-trigger" size="sm" variant="ghost" disabled={!!git.busy} aria-label={`Branch: ${label}. Switch or create a branch`} />}>
      <GitBranch aria-hidden size={13} strokeWidth={1.75} /><span>{label}</span><ChevronDown aria-hidden size={12} strokeWidth={1.75} />
    </PopoverTrigger>
    <PopoverPopup align="start" className="handwork-branch-popup" aria-label="Branches">
      <div className="handwork-branch-search">
        <Search aria-hidden size={13} strokeWidth={1.75} />
        <input autoFocus aria-label="Find or create a branch" placeholder="Find or create a branch" value={query} spellCheck={false} role="combobox" aria-expanded aria-controls={list} aria-activedescendant={options.length ? `${list}-${Math.min(active, options.length - 1)}` : undefined}
          onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown} />
      </div>
      <div id={list} role="listbox" aria-label="Local branches" className="handwork-branch-list">
        {!branches && !error && <p role="status">Loading branches…</p>}
        {error && <p role="alert">{error}</p>}
        {branches && !options.length && <p>No branches match.</p>}
        {options.map((option, index) => option.kind === 'branch'
          ? <div key={option.branch.name} id={`${list}-${index}`} role="option" aria-selected={index === active} aria-current={option.branch.current ? 'true' : undefined} className="handwork-branch-option" onMouseMove={() => setActive(index)} onClick={() => choose(option)}>
            <span className="handwork-branch-check">{option.branch.current && <Check aria-hidden size={13} />}</span>
            <span className="handwork-branch-text"><span className="handwork-branch-name">{option.branch.name}</span><span className="handwork-branch-meta">{[option.branch.track || (option.branch.upstream ? `→ ${option.branch.upstream}` : 'Not published'), option.branch.date ? relativeTime(option.branch.date) : ''].filter(Boolean).join(' · ')}</span></span>
          </div>
          : <div key="create" id={`${list}-${index}`} role="option" aria-selected={index === active} className="handwork-branch-option" data-create onMouseMove={() => setActive(index)} onClick={() => choose(option)}>
            <span className="handwork-branch-check"><GitBranchPlus aria-hidden size={13} /></span>
            <span className="handwork-branch-text"><span className="handwork-branch-name">Create branch <strong>{option.name}</strong></span><span className="handwork-branch-meta">From {state.head.branch ?? 'the current commit'}{state.head.oid ? ` at ${state.head.oid.slice(0, 7)}` : ''}</span></span>
          </div>)}
      </div>
      {dirty && <p className="handwork-branch-note">Uncommitted changes come with you. If switching would overwrite them, Git stops and nothing is lost.</p>}
    </PopoverPopup>
  </Popover>;
}

/** Keep routine sync compact; show push and pull when there is work to do. */
export function SyncBar({ state, git, api, workspace }: { state: Repository; git: GitRepository; api: DesktopAPI; workspace: string }) {
  if (!state.remotes.length) return <div className="handwork-sync"><div className="handwork-sync-row"><span className="handwork-sync-text">No remote configured. Add one in a terminal to push this repository.</span></div></div>;
  const busy = !!git.busy;
  const network = git.busy && NETWORK.includes(git.busy) ? git.busy : null;
  const destination = state.push ? `${state.push.remote}/${state.push.branch}` : '';
  const outgoing = state.push?.outgoing ?? state.publish?.outgoing ?? 0;
  const workflowBranch = state.push?.branch ?? state.publish?.branch;
  const push = () => state.push && git.run('push', () => api.gitPush(workspace, { remote: state.push!.remote, branch: state.push!.branch }), result => `Pushed to ${result.destination}.`);
  const publish = (remote: string) => git.run('publish', () => api.gitPublish(workspace, remote), result => `Published ${result.destination} and set it as upstream.`);
  const fetch = () => git.run('fetch', () => api.gitFetch(workspace), () => 'Fetched the latest remote changes.');
  const pull = () => git.run('pull', () => api.gitPull(workspace), () => `Pulled from ${state.upstream?.name}.`);
  return <div className={`handwork-sync${state.push ? ' handwork-sync-inline' : ''}`} aria-label="Sync with remote" role="group">
    {network && <div className="handwork-sync-row" data-progress role="status">
      <Spinner />
      <span className="handwork-sync-text">{operationLabel[network]}{network === 'push' && destination ? ` to ${destination}` : ''}{git.progress?.step ? ` · ${git.progress.step}` : ''}…</span>
      {git.progress?.percent !== undefined && <span className="handwork-sync-meter" role="progressbar" aria-valuenow={git.progress.percent} aria-valuemin={0} aria-valuemax={100} aria-label={git.progress.step ?? 'Progress'}><span style={{ '--handwork-progress': `${git.progress.percent}%` } as CSSProperties} /></span>}
    </div>}
    {state.push && <div className="handwork-sync-row">
      {outgoing ? <ArrowUp className="handwork-sync-icon" aria-hidden size={13} /> : state.behind ? <ArrowDown className="handwork-sync-icon" aria-hidden size={13} /> : <Check className="handwork-sync-icon" aria-hidden size={13} />}
      <HoverTooltip content={`${destination}${state.fetchedAt ? ` · Fetched ${relativeTime(state.fetchedAt)}` : ''}`}><span className="handwork-sync-text">{outgoing ? `${plural(outgoing, 'commit')} to push` : state.behind ? plural(state.behind, 'incoming commit') : 'Up to date'}</span></HoverTooltip>
      <Menu><MenuTrigger render={<Button size="xs" variant="link" aria-label="Remote actions" />}><ChevronDown size={12} aria-hidden /></MenuTrigger><MenuPopup align="end">
        <MenuGroupLabel>{destination}</MenuGroupLabel>
        <MenuItem disabled={busy} onClick={() => void fetch()}>Fetch remote changes</MenuItem>
        <MenuItem disabled={!state.upstream || state.upstream.gone || busy} onClick={() => void pull()}>Pull from {state.upstream?.name ?? 'upstream'}</MenuItem>
      </MenuPopup></Menu>
      {!!state.behind && <Button size="xs" variant="secondary" disabled={busy || !state.upstream || state.upstream.gone} onClick={() => void pull()}>Pull</Button>}
      {!!outgoing && <HoverTooltip content={`Push to ${destination}`}><Button size="xs" disabled={busy} onClick={() => void push()}>Push</Button></HoverTooltip>}
    </div>}
    {state.publish && <div className="handwork-sync-row">
      <ArrowUp className="handwork-sync-icon" aria-hidden size={13} strokeWidth={1.75} />
      <span className="handwork-sync-text">{state.publish.reason === 'mismatch'
        ? <>Tracks <code>{state.upstream?.name}</code>, which Git won’t push {state.publish.branch} to. Publish it under its own name.</>
        : <><strong>{state.publish.branch}</strong> isn’t on a remote yet{outgoing ? ` · ${plural(outgoing, 'local commit')}` : ''}</>}</span>
      {state.remotes.length === 1
        ? <HoverTooltip content={state.head.unborn ? 'Make a first commit to publish' : `Push ${state.publish.branch} to ${state.remotes[0].name}/${state.publish.branch} and track it`}><Button id="handwork-publish" size="xs" disabled={busy || state.head.unborn} onClick={() => void publish(state.remotes[0].name)}>Publish branch</Button></HoverTooltip>
        : <Menu>
          <MenuTrigger render={<Button id="handwork-publish" size="xs" disabled={busy || state.head.unborn} />}>Publish branch<ChevronDown aria-hidden size={12} /></MenuTrigger>
          <MenuPopup align="end" className="handwork-publish-menu">
            <MenuGroupLabel>Publish {state.publish.branch} to</MenuGroupLabel>
            {[...state.remotes].sort((a, b) => Number(b.name === state.publish!.defaultRemote) - Number(a.name === state.publish!.defaultRemote)).map(remote => <MenuItem key={remote.name} onClick={() => void publish(remote.name)}>
              <span className="handwork-publish-remote"><span>{remote.name}/{state.publish!.branch}</span><span>{remote.url}</span></span>
            </MenuItem>)}
          </MenuPopup>
        </Menu>}
    </div>}
    {!!state.workflows.length && workflowBranch && (outgoing > 0 || state.publish) && <div className="handwork-sync-row" data-tone="warning">
      <TriangleAlert className="handwork-sync-icon" aria-hidden size={13} strokeWidth={1.75} />
      <span className="handwork-sync-text">Pushing to <strong>{workflowBranch}</strong> runs {state.workflows.map((name, index) => <span key={name}>{index ? ', ' : ''}“{name}”</span>)}.</span>
    </div>}
    {!state.push && <div className="handwork-sync-row">
      <ArrowDown className="handwork-sync-icon" aria-hidden size={13} strokeWidth={1.75} />
      <span className="handwork-sync-text">{state.behind ? <>{plural(state.behind, 'incoming commit')} from <code>{state.upstream?.name}</code></> : state.fetchedAt ? `Fetched ${relativeTime(state.fetchedAt)}` : 'Never fetched'}</span>
      <HoverTooltip content="Download remote changes without changing your files"><Button size="xs" variant="ghost" disabled={busy} onClick={() => void fetch()}>Fetch</Button></HoverTooltip>
      <HoverTooltip content={state.upstream ? `Fast-forward from ${state.upstream.name}` : 'Publish this branch to pull'}><Button size="xs" variant={state.behind ? 'default' : 'ghost'} disabled={busy || !state.upstream || state.upstream.gone} onClick={() => void pull()}>Pull</Button></HoverTooltip>
    </div>}
  </div>;
}

const actionLabels: Record<GitAction, string> = { retry: 'Retry', terminal: 'Open terminal', pull: 'Pull', fetch: 'Fetch', publish: 'Publish branch', refresh: 'Refresh', branch: 'Create branch' };

export function GitNoticeView({ notice, onAction, onDismiss }: { notice: GitNotice; onAction: (action: GitAction) => void; onDismiss: () => void }) {
  if (notice.kind === 'success') return <p role="status" className="handwork-git-success"><Check aria-hidden size={13} />{notice.text}</p>;
  const { failure } = notice;
  const actions = failure.actions.filter(action => action !== 'retry' || notice.retry);
  return <div role="alert" className="handwork-git-error">
    <CircleAlert className="handwork-git-error-icon" aria-hidden size={14} strokeWidth={1.75} />
    <div className="handwork-git-error-body">
      <strong>{failure.title}</strong>
      <p>{failure.message}</p>
      {failure.detail && <details open={failure.code === 'identity'}><summary>{failure.code === 'identity' ? 'Commands' : 'Git output'}</summary><pre>{failure.detail}</pre></details>}
      {!!actions.length && <div className="handwork-git-error-actions">{actions.map((action, index) => <Button key={action} size="xs" variant={index === 0 ? 'outline' : 'ghost'} onClick={() => onAction(action)}>{action === 'terminal' && <SquareTerminal aria-hidden size={12} />}{actionLabels[action]}</Button>)}</div>}
    </div>
    <HoverTooltip content="Dismiss"><Button className="handwork-git-error-close" size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={onDismiss}><X size={13} aria-hidden /></Button></HoverTooltip>
  </div>;
}

type Draft = { summary: string; description: string };
function readDraft(repository: string): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(repository)) ?? 'null');
    if (typeof value?.summary === 'string' && typeof value.description === 'string') return { summary: value.summary, description: value.description };
  } catch { /* A missing draft starts empty. */ }
  return { summary: '', description: '' };
}

export type CommitWriting = { modelLabel?: string; modelPending?: boolean; onWrite?: () => ReturnType<DesktopAPI['gitCommitMessage']> };

export function CommitComposer({ state, git, api, workspace, modelLabel, modelPending, onWrite }: { state: Repository; git: GitRepository; api: DesktopAPI; workspace: string } & CommitWriting) {
  const [draft, setDraft] = useState(() => readDraft(state.repository));
  const [writing, setWriting] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [writeError, setWriteError] = useState('');
  const [written, setWritten] = useState<{ index: string; previous: Draft }>();
  useEffect(() => {
    try {
      if (draft.summary || draft.description) localStorage.setItem(draftKey(state.repository), JSON.stringify(draft));
      else localStorage.removeItem(draftKey(state.repository));
    } catch { /* The draft still lives in this panel. */ }
  }, [draft, state.repository]);
  const staged = state.staged.length;
  const outside = state.scope ? state.staged.filter(change => !change.inProject).length : 0;
  const blocker = state.head.detached ? 'Create a branch to commit; you’re on a detached HEAD.'
    : state.conflicts.length ? `Resolve ${plural(state.conflicts.length, 'conflicted file')} before committing.`
    : state.operation === 'rebase' ? 'Finish the rebase in a terminal before committing.'
    : !state.identity ? 'Set your Git name and email to commit.' : '';
  const canCommit = !!draft.summary.trim() && (staged > 0 || state.operation === 'merge') && !blocker && !git.busy && !writing;
  const commit = async () => {
    if (!canCommit) return;
    await git.run('commit', async () => {
      const result = await api.gitCommit(workspace, { summary: draft.summary.trim(), description: draft.description }, reviewedCommit(state));
      if (result.ok) {
        // Clear storage before the refreshed repository can unmount this editor.
        // Keeping cleanup in the action also covers a successful Retry.
        try { localStorage.removeItem(draftKey(state.repository)); } catch { /* Storage may be unavailable. */ }
        setDraft({ summary: '', description: '' });
        setWritten(undefined);
        setWriteError('');
        setEditorOpen(false);
        setDescriptionOpen(false);
      }
      return result;
    }, result => `Committed ${result.commit?.short} to ${state.head.branch}.`);
  };
  const write = async () => {
    if (writing || !staged || modelPending || git.busy) return;
    setWriting(true); setWriteError('');
    try {
      const message = await (onWrite ? onWrite() : api.gitCommitMessage(workspace));
      setWritten({ index: message.index, previous: draft });
      setDraft({ summary: message.summary, description: message.description });
      requestAnimationFrame(() => document.getElementById('handwork-commit-summary')?.focus({ preventScroll: true }));
    } catch (cause) { setWriteError(errorText(cause)); }
    finally { setWriting(false); }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (isMac() ? event.metaKey : event.ctrlKey)) { event.preventDefault(); void commit(); }
  };
  const length = draft.summary.trim().length;
  if (!staged && state.operation !== 'merge' && !draft.summary && !draft.description && !editorOpen) return <div className="handwork-commit-collapsed">
    <span>Stage files to commit</span>
    <Button size="xs" variant="link" onClick={() => setEditorOpen(true)}>Write a message</Button>
  </div>;
  return <form className="handwork-commit" aria-label="Commit staged changes" onSubmit={event => { event.preventDefault(); void commit(); }}>
    <div className="handwork-commit-editor" aria-busy={writing}>
      <div className="handwork-commit-summary" data-long={length > 72 ? '' : undefined}>
        <input id="handwork-commit-summary" aria-label="Commit summary" placeholder="Commit message" value={draft.summary} maxLength={500} disabled={writing || git.pending === 'commit'}
          onChange={event => setDraft(current => ({ ...current, summary: event.target.value.replace(/[\r\n]+/g, ' ') }))} onKeyDown={onKeyDown} />
        {length > 50 && <HoverTooltip content="Aim for 72 characters or fewer"><span className="handwork-commit-length">{length}/72</span></HoverTooltip>}
      </div>
      {(descriptionOpen || draft.description) && <textarea className="handwork-commit-description" aria-label="Commit description (optional)" placeholder="Add a description…" rows={2} value={draft.description} disabled={writing || git.pending === 'commit'}
        onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} onKeyDown={onKeyDown} />}
      <div className="handwork-commit-tools">
        {!descriptionOpen && !draft.description && <Button size="xs" variant="link" disabled={writing} onClick={() => setDescriptionOpen(true)}><Plus size={12} aria-hidden />Description</Button>}
        <HoverTooltip content={staged ? `Write summary and description using ${modelLabel ?? 'the selected chat model'}` : 'Stage files to generate a message'}><Button className="handwork-commit-generate" size="xs" variant="link" disabled={!staged || writing || modelPending || !!git.busy || !modelLabel} onClick={() => void write()}>{writing ? <Spinner /> : <Sparkles aria-hidden size={12} />}{writing ? 'Writing…' : 'Generate'}<span className="handwork-commit-model">{modelLabel}</span></Button></HoverTooltip>
      </div>
    </div>
    {writeError && <p role="alert" className="handwork-commit-hint" data-tone="error">{writeError}</p>}
    {written && !writeError && <p className="handwork-commit-hint">{written.index !== state.index ? <><TriangleAlert aria-hidden size={12} />Staged changes changed after this message was written.</> : <>Written from the staged diff. Edit it before committing.</>}
      <Button size="xs" variant="ghost" onClick={() => { setDraft(written.previous); setWritten(undefined); }}><Undo2 aria-hidden size={12} />Undo</Button></p>}
    {blocker && <p className="handwork-commit-hint" data-tone="warning">{blocker}</p>}
    <div className="handwork-commit-footer">
      <span className="handwork-commit-staging">{staged ? `${plural(staged, 'file')} staged` : 'No files staged'}{outside ? ` · ${outside} outside ${state.scope}` : ''}</span>
      <HoverTooltip content={`Commit staged changes (${isMac() ? '⌘' : 'Ctrl+'}Enter)`}><Button type="submit" size="xs" disabled={!canCommit}>{git.pending === 'commit' ? <Spinner /> : null}Commit</Button></HoverTooltip>
    </div>
  </form>;
}

function CommitRow({ commit, selected, onSelect, incoming }: { commit: GitCommitSummary; selected: boolean; onSelect: () => void; incoming?: boolean }) {
  return <HoverTooltip content={commit.subject}><button type="button" className="handwork-commit-row" aria-current={selected ? 'true' : undefined} data-local={commit.local ? '' : undefined} onClick={onSelect}>
    <span className="handwork-commit-dot" data-kind={incoming ? 'incoming' : commit.local ? 'local' : 'pushed'} aria-hidden />
    <span className="handwork-commit-text">
      <span className="handwork-commit-subject">{commit.subject || '(no message)'}</span>
      <span className="handwork-commit-meta">{commit.author} · {relativeTime(commit.date)} · <code>{commit.short}</code></span>
    </span>
    {commit.local && <span className="handwork-commit-badge">Not pushed</span>}
    {incoming && <span className="handwork-commit-badge" data-kind="incoming">Incoming</span>}
  </button></HoverTooltip>;
}

export function GitHistory({ api, workspace, state }: { api: DesktopAPI; workspace: string; state: Repository }) {
  const [log, setLog] = useState<GitLog>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [details, setDetails] = useState<GitCommitDetails>();
  const [detailsError, setDetailsError] = useState('');
  const [file, setFile] = useState('');
  const [diff, setDiff] = useState<ProjectFileDiff>();
  const [diffError, setDiffError] = useState('');
  const [context, setContext] = useState(DEFAULT_CONTEXT);
  const [wrap, setWrap] = useState(false);
  const [listHeight, setListHeight] = useStoredSize('handwork.historyHeight');
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const version = `${state.head.oid}:${state.push?.ref}:${state.push?.outgoing}:${state.publish?.outgoing}:${state.behind}`;
  useEffect(() => {
    let cancelled = false;
    api.gitLog(workspace, 100).then(value => { if (!cancelled) { setLog(value); setError(''); } }).catch(cause => { if (!cancelled) setError(errorText(cause)); });
    return () => { cancelled = true; };
  }, [api, workspace, version]);
  const commits = useMemo(() => [...(log?.incoming ?? []), ...(log?.commits ?? [])], [log]);
  const oid = commits.some(commit => commit.oid === selected) ? selected : log?.commits[0]?.oid ?? '';
  useEffect(() => {
    let cancelled = false;
    setDetails(undefined); setDetailsError(''); setFile(''); setContext(DEFAULT_CONTEXT);
    if (!oid) return;
    api.gitCommitDetails(workspace, oid).then(value => { if (!cancelled) setDetails(value); }).catch(cause => { if (!cancelled) setDetailsError(errorText(cause)); });
    return () => { cancelled = true; };
  }, [api, workspace, oid]);
  const currentDetails = details?.oid === oid ? details : undefined;
  const filePath = currentDetails?.files.some(item => item.path === file) ? file : currentDetails?.files[0]?.path ?? '';
  useEffect(() => {
    let cancelled = false;
    setDiffError('');
    if (!oid || !filePath) { setDiff(undefined); return; }
    api.gitCommitFileDiff(workspace, oid, filePath, context).then(value => { if (!cancelled) setDiff(value); }).catch(cause => { if (!cancelled) setDiffError(errorText(cause)); });
    return () => { cancelled = true; };
  }, [api, workspace, oid, filePath, context]);
  if (error && !log) return <p role="alert" className="handwork-changes-empty">{error}</p>;
  if (!log) return <p role="status" className="handwork-changes-empty">Reading history…</p>;
  if (!log.commits.length) return <div className="handwork-changes-clean"><GitBranch aria-hidden strokeWidth={1.5} /><p>No commits yet</p><span>Your first commit on {state.head.branch ?? 'this branch'} will appear here.</span></div>;
  const files = currentDetails?.files ?? [];
  const fileIndex = files.findIndex(item => item.path === filePath);
  const currentDiff = diff?.path === filePath && diff.oid === currentDetails?.oid ? diff : undefined;
  const selectedFile = files[fileIndex];
  return <div ref={container} className="handwork-history" data-sized={listHeight ? '' : undefined} style={listHeight ? { '--handwork-files-height': `${listHeight}px` } as CSSProperties : undefined}>
    <nav ref={list} className="handwork-changed-files handwork-commit-list" aria-label="Recent commits">
      {!!log.incoming.length && <>
        <h3 className="handwork-change-group-title">Incoming from {log.upstream}<span>{log.incoming.length}</span></h3>
        {log.incoming.map(commit => <CommitRow key={commit.oid} commit={commit} incoming selected={commit.oid === oid} onSelect={() => setSelected(commit.oid)} />)}
      </>}
      <h3 className="handwork-change-group-title">{state.head.branch ?? 'HEAD'}</h3>
      {log.commits.map(commit => <CommitRow key={commit.oid} commit={commit} selected={commit.oid === oid} onSelect={() => setSelected(commit.oid)} />)}
    </nav>
    <ResizeHandle className="handwork-files-resize" orientation="horizontal" direction={1} label="Resize commit list" min={56}
      max={() => (container.current?.clientHeight ?? 600) - 160} measure={() => list.current?.getBoundingClientRect().height} onResize={setListHeight} />
    <div className="handwork-file-review" role="region" aria-label="Commit details" tabIndex={0}>
      {detailsError && <p role="alert">{detailsError}</p>}
      {!currentDetails && !detailsError && <p role="status" className="handwork-changes-empty">Loading commit…</p>}
      {currentDetails && <>
        <div className="handwork-commit-details">
          <h3>{currentDetails.subject}</h3>
          {currentDetails.body && <p className="handwork-commit-body">{currentDetails.body}</p>}
          <p className="handwork-commit-meta"><HoverTooltip content={currentDetails.email}><span>{currentDetails.author}</span></HoverTooltip> · <HoverTooltip content={new Date(currentDetails.date).toLocaleString()}><time dateTime={new Date(currentDetails.date).toISOString()}>{relativeTime(currentDetails.date)}</time></HoverTooltip> · <HoverTooltip content={currentDetails.oid}><code>{currentDetails.short}</code></HoverTooltip>{currentDetails.parents.length > 1 ? ' · Merge, compared with its first parent' : ''}</p>
          {!!files.length && <ul className="handwork-commit-files" aria-label="Files in this commit">{files.map(item => {
            const { name, directory } = splitPath(item.path);
            return <li key={item.path}><HoverTooltip content={item.path}><button type="button" aria-current={item.path === filePath ? 'true' : undefined} onClick={() => setFile(item.path)}>
              <StatusBadge status={changeStatus(item)} />
              <span className="handwork-change-path"><span className="handwork-change-filename">{name}</span>{directory && <span className="handwork-change-directory">{directory}</span>}</span>
              {item.binary ? <span className="handwork-change-meta">Binary</span> : <ChangeCounts added={item.added} removed={item.removed} />}
            </button></HoverTooltip></li>;
          })}</ul>}
          {!files.length && <p className="handwork-changes-empty">This commit changes no files.</p>}
        </div>
        {selectedFile && <>
          <header className="handwork-file-review-header">
            <div className="handwork-file-review-title"><HoverTooltip content={selectedFile.path}><h3>{splitPath(selectedFile.path).name}</h3></HoverTooltip><p><span className="handwork-file-review-status" data-status={changeStatus(selectedFile)}>{changeStatus(selectedFile)}</span>{splitPath(selectedFile.path).directory && <> · {splitPath(selectedFile.path).directory}</>}</p></div>
            <div className="handwork-file-review-actions"><DiffControls context={context} onContext={setContext} wrap={wrap} onWrap={() => setWrap(value => !value)} canFold={!selectedFile.binary} index={fileIndex} count={files.length} onStep={offset => { const next = files[fileIndex + offset]; if (next) setFile(next.path); }} /></div>
          </header>
          <DiffSections detail={currentDiff} error={diffError} path={selectedFile.path} wrap={wrap} context={context} onContext={setContext} showLabels={false} />
        </>}
      </>}
    </div>
  </div>;
}
