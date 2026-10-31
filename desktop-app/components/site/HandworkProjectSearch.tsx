"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CaseSensitive, ChevronRight, File, LoaderCircle, Regex, WholeWord } from 'honestui/icons';
import type { DesktopAPI, ProjectSearchMatch, ProjectSearchOptions } from '@/lib/desktop-api';

type Results = { query: string; matches: ProjectSearchMatch[]; truncated: boolean };
/** Each project's last search, so switching back to the tree and here again keeps it. */
const remembered = new Map<string, { query: string; options: ProjectSearchOptions; results: Results | null; collapsed: string[] }>();

/** The sidebar is narrow: keep only a few words before the match, so the match itself stays in view. */
const leading = (text: string) => { const trimmed = text.trimStart(); return trimmed.length > 18 ? `…${trimmed.slice(-16).replace(/^\S*\s/, '')}` : trimmed; };
const cleanError = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);

/**
 * Find text in every file of the project, the way an editor's search sidebar
 * does: results grouped by file, each line opening the file at that match.
 */
export function HandworkProjectSearch({ api, workspace, focusToken, onOpen }: {
  api?: DesktopAPI; workspace: string;
  /** Changes when the person asks for search again, to focus and select the query. */
  focusToken: number;
  onOpen: (path: string, line: number, column: number, length: number) => void;
}) {
  const initial = remembered.get(workspace);
  const [query, setQuery] = useState(initial?.query ?? '');
  const [options, setOptions] = useState<ProjectSearchOptions>(initial?.options ?? { caseSensitive: false, wholeWord: false, regex: false });
  const [results, setResults] = useState<Results | null>(initial?.results ?? null);
  const [collapsed, setCollapsed] = useState<string[]>(initial?.collapsed ?? []);
  const [status, setStatus] = useState<{ loading: boolean; error?: string }>({ loading: false });
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  useEffect(() => { remembered.set(workspace, { query, options, results, collapsed }); }, [workspace, query, options, results, collapsed]);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [focusToken]);

  const trimmed = query.trim();
  useEffect(() => {
    const id = ++request.current;
    if (!trimmed || !api?.searchProjectFiles) { setResults(null); setStatus({ loading: false }); return; }
    setStatus(current => ({ ...current, loading: true }));
    const timer = setTimeout(() => {
      api.searchProjectFiles(workspace, query, options).then(found => {
        if (id !== request.current) return;
        setResults({ query, ...found });
        setStatus({ loading: false });
      }).catch(cause => { if (id === request.current) setStatus({ loading: false, error: cleanError(cause) }); });
    }, 250);
    return () => clearTimeout(timer);
    // `query` is sent untrimmed so leading spaces can be searched for; `trimmed` only decides whether to search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, workspace, query, options]);

  const groups = useMemo(() => groupMatches(results?.matches ?? []), [results]);

  const toggle = (key: keyof ProjectSearchOptions) => setOptions(current => ({ ...current, [key]: !current[key] }));
  const flag = (key: keyof ProjectSearchOptions, label: string, icon: ReactNode) =>
    <button type="button" className="handwork-search-flag" aria-label={label} title={label} aria-pressed={options[key]} onClick={() => toggle(key)}>{icon}</button>;

  const total = results?.matches.length ?? 0;
  return <div className="handwork-project-search">
    <div className="handwork-project-search-field">
      <input ref={input} type="search" value={query} spellCheck={false} placeholder="Search in files" aria-label="Search in files"
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && groups[0]) { const [path, [first]] = groups[0]; onOpen(path, first.line, first.column, first.length); } }} />
      {flag('caseSensitive', 'Match case', <CaseSensitive aria-hidden width={14} height={14} />)}
      {flag('wholeWord', 'Match whole word', <WholeWord aria-hidden width={14} height={14} />)}
      {flag('regex', 'Use regular expression', <Regex aria-hidden width={14} height={14} />)}
    </div>
    <div className="handwork-project-search-summary" role="status">
      {status.loading ? <><LoaderCircle aria-hidden width={12} height={12} className="motion-safe:animate-spin" />Searching…</>
        : status.error ? <span data-error>{status.error}</span>
        : results && trimmed ? total ? `${total.toLocaleString()}${results.truncated ? '+' : ''} ${total === 1 ? 'result' : 'results'} in ${groups.length.toLocaleString()} ${groups.length === 1 ? 'file' : 'files'}` : 'No results.'
        : null}
    </div>
    <div className="handwork-project-search-results" role="tree" aria-label="Search results">
      <MatchList groups={groups} collapsed={collapsed} onCollapsed={setCollapsed} onOpen={onOpen} />
      {results?.truncated && <div className="handwork-tree-note">Showing the first {total.toLocaleString()} results. Narrow the search to see the rest.</div>}
    </div>
  </div>;
}

/** Matches grouped under their file, each opening the file at the match; shared by search and references. */
export function MatchList({ groups, collapsed, onCollapsed, onOpen }: {
  groups: [string, ProjectSearchMatch[]][]; collapsed: string[]; onCollapsed: (collapsed: string[]) => void;
  onOpen: (path: string, line: number, column: number, length: number) => void;
}) {
  return <>{groups.map(([path, matches]) => {
    const open = !collapsed.includes(path);
    const slash = path.lastIndexOf('/');
    return <div key={path} role="none">
      <button type="button" role="treeitem" aria-expanded={open} className="handwork-tree-row handwork-search-file" title={path}
        onClick={() => onCollapsed(open ? [...collapsed, path] : collapsed.filter(item => item !== path))}>
        <ChevronRight className="handwork-tree-chevron" data-open={open || undefined} aria-hidden />
        <File className="handwork-tree-icon" aria-hidden />
        <span className="handwork-tree-name">{path.slice(slash + 1)}</span>
        {slash > 0 && <span className="handwork-search-dir">{path.slice(0, slash)}</span>}
        <span className="handwork-search-count">{matches.length}</span>
      </button>
      {open && <div role="group">{matches.map(match => <button key={`${match.line}:${match.column}`} type="button" role="treeitem" className="handwork-tree-row handwork-search-match" title={`${path}:${match.line}`}
        onClick={() => onOpen(path, match.line, match.column, match.length)}>
        <span className="handwork-search-line">{match.line}</span>
        <span className="handwork-search-preview">{leading(match.preview.slice(0, match.offset))}<mark>{match.preview.slice(match.offset, match.offset + match.length)}</mark>{match.preview.slice(match.offset + match.length)}</span>
      </button>)}</div>}
    </div>;
  })}</>;
}

/** Group matches by file, in the order the files first appear. */
export function groupMatches(matches: readonly ProjectSearchMatch[]): [string, ProjectSearchMatch[]][] {
  const byFile = new Map<string, ProjectSearchMatch[]>();
  for (const match of matches) byFile.set(match.path, [...(byFile.get(match.path) ?? []), match]);
  return [...byFile.entries()];
}

