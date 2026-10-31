"use client";
import { useEffect, useMemo, useState } from 'react';
import { File, Search } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { Command, CommandContent, CommandDialog, CommandDialogContent, CommandEmpty, CommandItem, CommandInput } from '@/components/ui/command';
import type { DesktopAPI } from '@/lib/desktop-api';
import { rankPaths } from '@/lib/fuzzy-path';

/** Each project's file list, kept so quick open shows results at once and refreshes behind them. */
const indexes = new Map<string, { files: string[]; truncated: boolean }>();

/** Matched letters are marked, a run of them as one mark so the word does not break apart. */
function Marked({ text, positions, offset }: { text: string; positions: Set<number>; offset: number }) {
  const runs: { text: string; marked: boolean }[] = [];
  for (let index = 0; index < text.length; index++) {
    const marked = positions.has(index + offset);
    const last = runs[runs.length - 1];
    if (last && last.marked === marked) last.text += text[index]; else runs.push({ text: text[index], marked });
  }
  return <>{runs.map((run, index) => run.marked ? <mark key={index}>{run.text}</mark> : run.text)}</>;
}

/** ⌘P: find a file in the project by typing parts of its name or path. */
export function HandworkQuickOpen({ open, onOpenChange, api, workspace, recent, onPick }: {
  open: boolean; onOpenChange: (open: boolean) => void; api?: DesktopAPI; workspace: string;
  /** Files open in tabs, offered first before anything is typed. */
  recent: string[];
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(() => indexes.get(workspace));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) { setQuery(''); return; }
    setIndex(indexes.get(workspace));
    setError('');
    if (!api?.indexProjectFiles) return;
    let live = true;
    api.indexProjectFiles(workspace).then(result => { indexes.set(workspace, result); if (live) setIndex(result); })
      .catch(cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [open, api, workspace]);

  const trimmed = query.trim();
  const results = useMemo(() => {
    const files = index?.files ?? [];
    if (trimmed) return rankPaths(files, trimmed, 80);
    const present = new Set(files);
    const first = recent.filter(path => !index || present.has(path));
    const shown = new Set(first);
    return [...first, ...files.filter(path => !shown.has(path)).sort().slice(0, 80 - first.length)].map(path => ({ path, score: 0, positions: [] as number[] }));
  }, [index, trimmed, recent]);

  const pick = (path: string) => { onOpenChange(false); onPick(path); };
  return <CommandDialog open={open} onOpenChange={onOpenChange}>
    <CommandDialogContent title="Go to file" className="handwork-chat-search handwork-palette handwork-quick-open">
      <Command key={String(open)} items={results.map(result => result.path)} mode="none" value={query} onValueChange={value => setQuery(value)}>
        <div className="handwork-search-heading">
          <CommandInput aria-label="Search files by name" placeholder="Search files by name…" leadingIcon={<Search />} />
          <Button variant="ghost" size="sm" aria-label="Close" onClick={() => onOpenChange(false)}>Esc</Button>
        </div>
        <CommandContent aria-label="Files">
          {!results.length && <CommandEmpty>{error ? error : !index ? 'Listing files…' : trimmed ? `No files match “${trimmed}”.` : 'This project has no files.'}</CommandEmpty>}
          {results.map(({ path, positions }) => {
            const nameStart = path.lastIndexOf('/') + 1;
            const marked = new Set(positions);
            return <CommandItem key={path} value={path} leadingIcon={<File />} onClick={() => pick(path)}>
              <span className="handwork-search-title"><Marked text={path.slice(nameStart)} positions={marked} offset={nameStart} /></span>
              {nameStart > 0 && <span className="handwork-search-project"><Marked text={path.slice(0, nameStart - 1)} positions={marked} offset={0} /></span>}
            </CommandItem>;
          })}
          {index?.truncated && <p className="handwork-palette-note">This project is large; only its first {index.files.length.toLocaleString()} files are searched.</p>}
        </CommandContent>
        <div className="handwork-search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span>Separate words to match folders and names</span></div>
      </Command>
    </CommandDialogContent>
  </CommandDialog>;
}
