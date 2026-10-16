"use client";

import { ArrowRightLeft, Brain, ChevronDown, CircleAlert, FileText, Globe, LoaderCircle, PencilLine, Search, SquareTerminal, Trash2, Wrench } from 'honestui/icons';
import type { Entry } from '@/lib/desktop-state';
import { lineDiff } from '@/lib/line-diff';
import { toolLabel } from '@/lib/transcript-activity';
import { ChangeCounts } from './HandworkChanges';

const KIND_ICONS = { read: FileText, edit: PencilLine, delete: Trash2, move: ArrowRightLeft, search: Search, execute: SquareTerminal, think: Brain, fetch: Globe } as const;

function kindIcon(entry: Entry) {
  const kind = entry.toolKind as keyof typeof KIND_ICONS | undefined;
  if (kind && KIND_ICONS[kind]) return KIND_ICONS[kind];
  const title = (entry.title ?? '').toLowerCase();
  return /read/.test(title) ? FileText : /edit|writ/.test(title) ? PencilLine : /search|match|find|grep/.test(title) ? Search : /run|exec|command/.test(title) ? SquareTerminal : /fetch|web/.test(title) ? Globe : Wrench;
}

const isDone = (entry: Entry) => entry.status === 'completed' || entry.status === 'failed';

function ActivityRow({ entry }: { entry: Entry }) {
  const Icon = entry.status === 'failed' ? CircleAlert : !isDone(entry) ? LoaderCircle : kindIcon(entry);
  const state = entry.status === 'failed' ? 'failed' : isDone(entry) ? 'done' : 'running';
  const changes = (entry.diffs ?? []).map(diff => ({ path: diff.path, ...lineDiff(diff.oldText, diff.newText) }));
  const input = entry.input && entry.input !== '{}' ? entry.input : '';
  const hasDetail = !!(input || entry.text || changes.length);
  const label = toolLabel(entry);
  const head = <>
    <Icon className="handwork-activity-icon" aria-hidden strokeWidth={1.75} />
    <span className="handwork-activity-label" title={label}>{label}</span>
    {state === 'failed' && <span className="handwork-activity-state">Failed</span>}
    {state === 'running' && <span className="handwork-activity-state">Running</span>}
    {hasDetail && <ChevronDown className="handwork-activity-chevron" aria-hidden strokeWidth={1.75} />}
  </>;
  if (!hasDetail) return <li className="handwork-activity-row" data-state={state}><div className="handwork-activity-head">{head}</div></li>;
  return <li className="handwork-activity-row" data-state={state}>
    <details>
      <summary className="handwork-activity-head">{head}</summary>
      <div className="handwork-activity-detail">
        {changes.length > 0 && <ul className="handwork-activity-files">{changes.map(change => <li key={change.path}>
          <span title={change.path}>{change.path.split('/').at(-1)}</span><ChangeCounts added={change.add} removed={change.del} />
        </li>)}</ul>}
        {input && <><div className="handwork-activity-caption">Input</div><pre>{input}</pre></>}
        {entry.text && <><div className="handwork-activity-caption">Output</div><pre>{entry.text}</pre></>}
      </div>
    </details>
  </li>;
}

export default function HandworkActivity({ entries, workspaceName, used, capacity }: {
  entries: Entry[]; workspaceName: string; used?: number; capacity?: number;
}) {
  const turns: { prompt?: Entry; tools: Entry[] }[] = [];
  for (const entry of entries) {
    if (entry.kind === 'user') turns.push({ prompt: entry, tools: [] });
    else if (entry.kind === 'tool') {
      if (!turns.length) turns.push({ tools: [] });
      turns[turns.length - 1].tools.push(entry);
    }
  }
  const shown = turns.filter(turn => turn.tools.length);
  const tools = entries.filter(entry => entry.kind === 'tool');
  const failed = tools.filter(entry => entry.status === 'failed').length;
  const running = tools.filter(entry => !isDone(entry)).length;
  const edited = new Set(tools.flatMap(entry => (entry.diffs ?? []).map(diff => diff.path))).size;
  const share = used !== undefined && capacity ? Math.min(1, used / capacity) : undefined;

  return <div className="handwork-activity">
    <div className="handwork-activity-summary">
      <div className="handwork-activity-stats">
        <span><strong>{tools.length}</strong> {tools.length === 1 ? 'step' : 'steps'}</span>
        {running > 0 && <span data-tone="running"><strong>{running}</strong> running</span>}
        {failed > 0 && <span data-tone="failed"><strong>{failed}</strong> failed</span>}
        {edited > 0 && <span><strong>{edited}</strong> {edited === 1 ? 'file' : 'files'} edited</span>}
      </div>
      {used !== undefined && <div className="handwork-activity-context">
        <div className="handwork-activity-context-label"><span>Context{workspaceName ? ` · ${workspaceName}` : ''}</span><span>{used.toLocaleString()}{capacity ? ` / ${capacity.toLocaleString()}` : ''} tokens</span></div>
        {share !== undefined && <div className="handwork-activity-meter" role="meter" aria-label="Context used" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={used} data-level={share > 0.85 ? 'high' : share > 0.6 ? 'medium' : undefined}><span style={{ width: `${share * 100}%` }} /></div>}
      </div>}
    </div>
    {shown.map((turn, index) => <section key={turn.prompt?.id ?? `turn-${index}`} className="handwork-activity-turn" aria-label={turn.prompt ? `Activity for: ${turn.prompt.text.slice(0, 80)}` : 'Activity'}>
      {turn.prompt && <h3 className="handwork-activity-prompt" title={turn.prompt.text}>{turn.prompt.text.split('\n')[0] || 'Message'}</h3>}
      <ol className="handwork-activity-list">{turn.tools.map(entry => <ActivityRow key={entry.id} entry={entry} />)}</ol>
    </section>)}
  </div>;
}
