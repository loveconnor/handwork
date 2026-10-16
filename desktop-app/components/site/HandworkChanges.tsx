"use client";

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ResizeHandle, useStoredSize } from '@/components/site/HandworkResizeHandle';
import { SyntaxLine, useSyntax } from 'honestui/syntax/react';
import { Button } from '@/components/ui/button';
import { ArrowDown, ArrowUp, ChevronDown, FileDiff, FoldVertical, TextWrap, UnfoldVertical } from 'honestui/icons';
import type { DesktopAPI, ProjectChangeFile, ProjectChangesSnapshot, ProjectFileDiff } from '@/lib/desktop-api';

type ReviewLine =
  | { kind: 'context' | 'added' | 'removed'; text: string; oldLine?: number; newLine?: number }
  | { kind: 'hunk'; text: string; context: string; hiddenAbove: boolean };

const DEFAULT_CONTEXT = 3, EXPAND_STEP = 20, FULL_FILE = 1000000;
type FileStatus = 'Conflict' | 'Deleted' | 'Renamed' | 'Added' | 'Modified';

function fileStatus(item: ProjectChangeFile): FileStatus {
  return item.status.includes('U') ? 'Conflict' : item.status.includes('D') ? 'Deleted' : item.status.includes('R') ? 'Renamed' : item.untracked || item.status.includes('A') ? 'Added' : 'Modified';
}

function StatusBadge({ status }: { status: FileStatus }) {
  return <span className="handwork-file-status" data-status={status} title={status} aria-hidden />;
}

function splitPath(path: string) {
  const slash = path.lastIndexOf('/');
  return { name: path.slice(slash + 1), directory: path.slice(0, Math.max(0, slash)) };
}

export function ChangeCounts({ added, removed }: { added: number; removed: number }) {
  return <span className="handwork-change-counts" aria-label={`${added} added lines, ${removed} removed lines`}><span className="handwork-added">+{added.toLocaleString()}</span><span className="handwork-removed">−{removed.toLocaleString()}</span></span>;
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

function DiffBody({ lines, path, wrap, onExpand }: { lines: ReviewLine[]; path: string; wrap: boolean; onExpand?: () => void }) {
  const [visible, setVisible] = useState(400);
  const shown = lines.slice(0, visible);
  const extension = path.split('.').at(-1);
  const code = shown.filter(line => line.kind !== 'hunk');
  const syntax = useSyntax(code.map(line => line.text).join('\n'), extension === 'mjs' || extension === 'cjs' ? 'js' : extension);
  let codeIndex = 0;
  return <>
    <div className="handwork-diff honest-syntax" data-syntax-palette="violet" data-wrap={wrap ? '' : undefined} role="table" aria-label={`Diff of ${path}`}>
      {shown.map((line, index) => {
        if (line.kind === 'hunk') {
          const label = <>{line.text}{line.context && <span className="handwork-diff-hunk-context"> {line.context}</span>}</>;
          return <div key={index} className="handwork-diff-hunk" role="row"><span role="cell">{onExpand && line.hiddenAbove
            ? <button type="button" className="handwork-diff-expand" title={`Show ${EXPAND_STEP} more lines around each change`} onClick={onExpand}><UnfoldVertical aria-hidden size={12} strokeWidth={1.75} /><span className="handwork-diff-hunk-label">{label}</span></button>
            : <span className="handwork-diff-hunk-label">{label}</span>}</span></div>;
        }
        const tokens = syntax?.lines[codeIndex++];
        const sign = line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : '';
        return <div key={index} className="handwork-diff-line" data-kind={line.kind} role="row">
          <span className="handwork-diff-number" role="cell" aria-hidden>{line.oldLine ?? ''}</span>
          <span className="handwork-diff-number" role="cell" aria-hidden>{line.newLine ?? ''}</span>
          <span className="handwork-diff-sign" role="cell" aria-label={line.kind === 'context' ? undefined : line.kind}>{sign}</span>
          <span className="handwork-diff-code" role="cell">{tokens ? <SyntaxLine tokens={tokens} /> : line.text}{'\n'}</span>
        </div>;
      })}
    </div>
    {visible < lines.length && <Button className="handwork-diff-more" variant="ghost" size="sm" onClick={() => setVisible(count => count + 400)}>Show {Math.min(400, lines.length - visible).toLocaleString()} more lines</Button>}
  </>;
}

function sectionLines(section: ProjectFileDiff['sections'][number]): ReviewLine[] {
  if (section.text !== undefined) {
    if (!section.text) return [];
    const text = section.text.endsWith('\n') ? section.text.slice(0, -1) : section.text;
    return text.split('\n').map((text, index) => ({ text, kind: 'added', newLine: index + 1 }));
  }
  const result: ReviewLine[] = [];
  let oldLine = 0, newLine = 0;
  const raw = (section.patch ?? '').split('\n');
  for (const [index, line] of raw.entries()) {
    if (index === raw.length - 1 && !line) continue;
    if (/^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode)/.test(line)) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); result.push({ kind: 'hunk', text: line.slice(0, line.indexOf('@@', 2) + 2), context: hunk[3], hiddenAbove: oldLine > 1 || newLine > 1 }); continue; }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) result.push({ kind: 'added', text: line.slice(1), newLine: newLine++ });
    else if (line.startsWith('-')) result.push({ kind: 'removed', text: line.slice(1), oldLine: oldLine++ });
    else result.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line, oldLine: oldLine++, newLine: newLine++ });
  }
  return result;
}

export default function HandworkChanges({ api, workspace, snapshot, loading, error }: {
  api?: DesktopAPI; workspace: string; snapshot?: ProjectChangesSnapshot; loading: boolean; error?: string;
}) {
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<ProjectFileDiff>();
  const [diffError, setDiffError] = useState('');
  const [listOpen, setListOpen] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [listHeight, setListHeight] = useStoredSize('handwork.changedFilesHeight');
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const [contexts, setContexts] = useState<Record<string, number>>({});
  const file = snapshot?.files.find(file => file.path === selected) ?? snapshot?.files[0];
  const selectedPath = file?.path;
  const context = (selectedPath ? contexts[selectedPath] : undefined) ?? DEFAULT_CONTEXT;
  const setContext = (value: number) => { if (selectedPath) setContexts(current => ({ ...current, [selectedPath]: value })); };
  useEffect(() => {
    let cancelled = false;
    if (!api || !workspace || !selectedPath) { setDetail(undefined); return; }
    setDiffError('');
    void api.projectFileDiff(workspace, selectedPath, context).then(value => {
      if (!cancelled && value.workspace === workspace && value.path === selectedPath) setDetail(value);
    }).catch(cause => { if (!cancelled) setDiffError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [api, workspace, selectedPath, context, snapshot?.checkedAt]);

  if (!workspace) return <p className="handwork-changes-empty">Select a project to see its changes.</p>;
  if (!api) return <p className="handwork-changes-empty">Open the desktop app to review project changes.</p>;
  if (!snapshot && !error) return <p role="status" className="handwork-changes-empty">{loading ? 'Reading project changes…' : 'Waiting for the project…'}</p>;
  const currentDetail = detail?.workspace === workspace && detail.path === selectedPath ? detail : undefined;
  const files = snapshot?.files ?? [];
  const fileIndex = file ? files.indexOf(file) : -1;
  const totals = files.reduce((sum, item) => ({ added: sum.added + item.added, removed: sum.removed + item.removed }), { added: 0, removed: 0 });
  const step = (offset: number) => { const next = files[fileIndex + offset]; if (next) setSelected(next.path); };
  const fileName = file && splitPath(file.path);
  const singleSection = currentDetail?.sections.length === 1;
  return <div ref={container} className="handwork-changes" data-sized={listHeight ? '' : undefined} style={listHeight ? { '--handwork-files-height': `${listHeight}px` } as CSSProperties : undefined}>
    {error && <p role="alert">{error}{snapshot ? ' The list may be out of date.' : ''}</p>}
    {snapshot?.kind === 'not-repository' && <p className="handwork-changes-empty">This project is not a Git repository.</p>}
    {snapshot?.kind === 'repository' && !file && <div className="handwork-changes-clean"><FileDiff aria-hidden strokeWidth={1.5} /><p>No uncommitted changes</p><span>Edits to this project will show up here.</span></div>}
    {file && fileName && <>
      <button type="button" className="handwork-changes-summary" aria-expanded={listOpen} aria-controls="handwork-changed-files" onClick={() => setListOpen(open => !open)}>
        <ChevronDown className="handwork-changes-chevron" aria-hidden strokeWidth={1.75} />
        <span>{snapshot?.truncated ? `${files.length} of ${snapshot.totalFiles}` : files.length} {(snapshot?.totalFiles ?? files.length) === 1 ? 'file' : 'files'} changed</span>
        <ChangeCounts added={totals.added} removed={totals.removed} />
      </button>
      {listOpen && <nav ref={list} id="handwork-changed-files" aria-label="Changed files" className="handwork-changed-files">{files.map(item => {
        const { name, directory } = splitPath(item.path);
        const status = fileStatus(item);
        return <Button key={item.path} variant="link" size="sm" aria-label={`${item.path}, ${status}`} title={item.path} aria-controls="handwork-file-diff" aria-current={item.path === file.path ? 'true' : undefined} onClick={() => setSelected(item.path)}>
          <StatusBadge status={status} />
          <span className="handwork-change-path"><span className="handwork-change-filename">{name}</span>{directory && <span className="handwork-change-directory">{directory}</span>}</span>
          {item.binary ? <span className="handwork-change-meta">Binary</span> : item.complete ? <ChangeCounts added={item.added} removed={item.removed} /> : <span className="handwork-change-meta" title="Line counts unavailable">—</span>}
        </Button>;
      })}</nav>}
      {listOpen && <ResizeHandle className="handwork-files-resize" orientation="horizontal" direction={1} label="Resize file list" min={56}
        max={() => (container.current?.clientHeight ?? 600) - 160}
        measure={() => list.current?.getBoundingClientRect().height} onResize={setListHeight} />}
      <div key={file.path} id="handwork-file-diff" className="handwork-file-review" role="region" aria-label={`Changes to ${file.path}`} tabIndex={0}>
        <header className="handwork-file-review-header">
          <div className="handwork-file-review-title">
            <h3 title={file.path}>{fileName.name}</h3>
            <p><span className="handwork-file-review-status" data-status={fileStatus(file)}>{fileStatus(file)}</span>{fileName.directory && <> · {fileName.directory}</>} · {file.untracked ? 'Untracked' : file.status.includes('U') ? 'Merge conflict' : file.status.includes('D') ? 'Deleted' : file.staged && file.unstaged ? 'Staged and unstaged' : file.staged ? 'Staged' : 'Unstaged'}</p>
          </div>
          {file.complete && !file.binary && <ChangeCounts added={file.added} removed={file.removed} />}
          <div className="handwork-file-review-actions">
            {!file.untracked && !file.binary && (context > DEFAULT_CONTEXT
              ? <Button size="icon-sm" variant="ghost" aria-label="Collapse unchanged lines" title="Collapse unchanged lines" onClick={() => setContext(DEFAULT_CONTEXT)}><FoldVertical size={14} aria-hidden /></Button>
              : <Button size="icon-sm" variant="ghost" aria-label="Show full file" title="Show full file" onClick={() => setContext(FULL_FILE)}><UnfoldVertical size={14} aria-hidden /></Button>)}
            <Button size="icon-sm" variant="ghost" aria-label="Wrap long lines" title="Wrap long lines" aria-pressed={wrap} onClick={() => setWrap(value => !value)}><TextWrap size={14} aria-hidden /></Button>
            {files.length > 1 && <>
              <Button size="icon-sm" variant="ghost" aria-label="Previous file" title="Previous file" disabled={fileIndex <= 0} onClick={() => step(-1)}><ArrowUp size={14} aria-hidden /></Button>
              <Button size="icon-sm" variant="ghost" aria-label="Next file" title="Next file" disabled={fileIndex >= files.length - 1} onClick={() => step(1)}><ArrowDown size={14} aria-hidden /></Button>
            </>}
          </div>
        </header>
        {diffError && <p role="alert">{diffError}{currentDetail ? ' The preview may be out of date.' : ''}</p>}
        {!currentDetail && !diffError && <p role="status" className="handwork-changes-empty">Loading diff…</p>}
        {currentDetail?.sections.map(section => <section key={section.label} className="handwork-recorded-edit" aria-label={section.label}>
          {!singleSection && <h4>{section.label}</h4>}{section.note && <p>{section.note}</p>}
          {section.text === '' && <p>Empty file.</p>}
          <DiffBody path={file.path} wrap={wrap} lines={sectionLines(section)} onExpand={context < FULL_FILE ? () => setContext(Math.min(FULL_FILE, context + EXPAND_STEP)) : undefined} />
        </section>)}
      </div>
    </>}
  </div>;
}
