"use client";

import { HoverTooltip } from "@/components/ui/tooltip";
import { useState } from 'react';
import { SyntaxLine, useSyntax } from 'honestui/syntax/react';
import { Button } from '@/components/ui/button';
import { ArrowDown, ArrowUp, FoldVertical, TextWrap, UnfoldVertical } from 'honestui/icons';
import type { ProjectFileDiff } from '@/lib/desktop-api';
import type { FileStatus } from '@/lib/git-format';

type ReviewLine =
  | { kind: 'context' | 'added' | 'removed'; text: string; oldLine?: number; newLine?: number }
  | { kind: 'hunk'; text: string; context: string; hiddenAbove: boolean };

export const DEFAULT_CONTEXT = 3, EXPAND_STEP = 20, FULL_FILE = 1000000;

export function StatusBadge({ status }: { status: FileStatus }) {
  return <HoverTooltip content={status}><span className="handwork-file-status" data-status={status}  aria-hidden /></HoverTooltip>;
}

export function splitPath(path: string) {
  const slash = path.lastIndexOf('/');
  return { name: path.slice(slash + 1), directory: path.slice(0, Math.max(0, slash)) };
}

export function ChangeCounts({ added, removed }: { added: number; removed: number }) {
  return <span className="handwork-change-counts" aria-label={`${added} added lines, ${removed} removed lines`}><span className="handwork-added">+{added.toLocaleString()}</span><span className="handwork-removed">−{removed.toLocaleString()}</span></span>;
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
            ? <HoverTooltip content={`Show ${EXPAND_STEP} more lines around each change`}><button type="button" className="handwork-diff-expand"  onClick={onExpand}><UnfoldVertical aria-hidden size={12} strokeWidth={1.75} /><span className="handwork-diff-hunk-label">{label}</span></button></HoverTooltip>
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
    if (/^(diff --git |diff --cc |index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode)/.test(line)) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); result.push({ kind: 'hunk', text: line.slice(0, line.indexOf('@@', 2) + 2), context: hunk[3], hiddenAbove: oldLine > 1 || newLine > 1 }); continue; }
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) result.push({ kind: 'added', text: line.slice(1), newLine: newLine++ });
    else if (line.startsWith('-')) result.push({ kind: 'removed', text: line.slice(1), oldLine: oldLine++ });
    else result.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line, oldLine: oldLine++, newLine: newLine++ });
  }
  return result;
}

/** Fold, wrap and file stepping controls shared by every diff header. */
export function DiffControls({ context, onContext, wrap, onWrap, canFold, index, count, onStep }: {
  context: number; onContext: (value: number) => void; wrap: boolean; onWrap: () => void; canFold: boolean; index: number; count: number; onStep: (offset: number) => void;
}) {
  return <>
    {canFold && (context > DEFAULT_CONTEXT
      ? <Button size="icon-sm" variant="ghost" aria-label="Collapse unchanged lines" title="Collapse unchanged lines" onClick={() => onContext(DEFAULT_CONTEXT)}><FoldVertical size={14} aria-hidden /></Button>
      : <Button size="icon-sm" variant="ghost" aria-label="Show full file" title="Show full file" onClick={() => onContext(FULL_FILE)}><UnfoldVertical size={14} aria-hidden /></Button>)}
    <Button size="icon-sm" variant="ghost" aria-label="Wrap long lines" title="Wrap long lines" aria-pressed={wrap} onClick={onWrap}><TextWrap size={14} aria-hidden /></Button>
    {count > 1 && <>
      <Button size="icon-sm" variant="ghost" aria-label="Previous file" title="Previous file" disabled={index <= 0} onClick={() => onStep(-1)}><ArrowUp size={14} aria-hidden /></Button>
      <Button size="icon-sm" variant="ghost" aria-label="Next file" title="Next file" disabled={index >= count - 1} onClick={() => onStep(1)}><ArrowDown size={14} aria-hidden /></Button>
    </>}
  </>;
}

/** The sections of one file's diff, or its loading and error states. */
export function DiffSections({ detail, error, path, wrap, context, onContext, showLabels = true }: {
  detail?: ProjectFileDiff; error?: string; path: string; wrap: boolean; context: number; onContext: (value: number) => void; showLabels?: boolean;
}) {
  const single = detail?.sections.length === 1;
  return <>
    {error && <p role="alert">{error}{detail ? ' The preview may be out of date.' : ''}</p>}
    {!detail && !error && <p role="status" className="handwork-changes-empty">Loading diff…</p>}
    {detail?.sections.map(section => <section key={section.label} className="handwork-recorded-edit" aria-label={section.label}>
      {showLabels && !single && <h4>{section.label}</h4>}{section.note && <p>{section.note}</p>}
      {section.text === '' && <p>Empty file.</p>}
      <DiffBody path={path} wrap={wrap} lines={sectionLines(section)} onExpand={context < FULL_FILE ? () => onContext(Math.min(FULL_FILE, context + EXPAND_STEP)) : undefined} />
    </section>)}
  </>;
}
