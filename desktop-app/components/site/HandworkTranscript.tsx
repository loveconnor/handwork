"use client";

import { HoverTooltip } from "@/components/ui/tooltip";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import HandworkInteractiveView from './HandworkInteractiveView';
import { ChatMessage } from '@/components/ui/chat-thread';
import { Markdown } from 'honestui/ai/markdown';
import { mathPlugins } from 'honestui/ai/markdown-math';
import { prepareMath } from '@/lib/markdown-math';
import { HandworkMermaid } from '@/components/site/HandworkMermaid';
import { ThinkingState, ThinkingText } from 'honestui/ai/thinking-state';
import { ToolChips, type ToolCall } from 'honestui/ai/tool-chips';
import { StreamingText, StreamingCitation } from 'honestui/ai/streaming-text';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, RotateCcw, FileText, FileImage, FileCode, FolderOpen, ExternalLink } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import type { Entry, EntryAttachment } from '@/lib/desktop-state';
import type { FileTarget } from '@/components/site/HandworkFileViewer';
import { revealLabel } from '@/components/site/HandworkFileViewer';
import { lineDiff, type DiffLine } from '@/lib/line-diff';
import { transcriptBlocks, toolLabel } from '@/lib/transcript-activity';
import { bareGenuiSource } from '@/lib/genui-response';
import { actionSubmission } from '@/lib/genui-action';
import { replySources, siteName, sourceUrl } from '@/lib/reply-sources';
import { isResponseError } from '@/lib/response-error';
import { HandworkResponseError } from './HandworkResponseError';

/** A link a reply makes to a file on this computer, such as file:///… or /Users/…/notes.md. */
export function localFileTarget(href?: string): string | undefined {
  if (!href) return undefined;
  if (/^file:\/\//i.test(href)) return href;
  if (/^(\/|~\/|[a-zA-Z]:[\\/])/.test(href) && !href.startsWith('//')) return decodeURI(href.split('#')[0]);
  return undefined;
}
const fileName = (target: string) => decodeURIComponent(target.split(/[\\/]/).filter(Boolean).pop() || target);

function AssistantReply({ text, streaming, onSend, onOpenFile }: { text: string; streaming: boolean; onSend: (text: string) => Promise<void>; onOpenFile: (file: FileTarget) => void }) {
  const { markdown, sources } = useMemo(() => replySources(text), [text]);
  const prepared = useMemo(() => prepareMath(markdown, streaming), [markdown, streaming]);
  return <StreamingText status={streaming ? 'streaming' : 'complete'} sources={sources} announce={false} onClick={event => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const href = sourceUrl(anchor?.getAttribute('href') ?? undefined);
    if (!href) return;
    event.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
  }}>
    <Markdown syntaxHighlighting syntaxPalette="violet" isStreaming={streaming} remarkPlugins={mathPlugins.remarkPlugins} rehypePlugins={mathPlugins.rehypePlugins} components={{
      a: ({ children, href }) => {
        const url = sourceUrl(href);
        const local = url ? undefined : localFileTarget(href);
        if (local) return <HoverTooltip content={local}><button type="button" className="handwork-file-link"  onClick={() => onOpenFile({ name: fileName(local), target: local })}>{children}</button></HoverTooltip>;
        if (!url) return <span>{children}</span>;
        const source = sources.find(item => item.href === url);
        // A bare-domain link shows the site's name; the tooltip keeps the exact source.
        const bare = !!source && source.title === source.domain;
        return <HoverTooltip content={source && !bare ? `${source.title} · ${source.domain}` : source?.domain || url}><StreamingCitation className="handwork-citation" data-bare={bare || undefined} href={url} target="_blank" rel="noopener noreferrer" aria-label={source ? `${bare ? siteName(source.domain) : source.title}, source: ${source.domain}` : undefined}>{bare ? siteName(source.domain) : children}</StreamingCitation></HoverTooltip>;
      },
      img: ({ alt }) => <span>[Image: {alt || 'remote image not loaded'}]</span>,
    }} blocks={{ honestai: source => <HandworkInteractiveView source={source} streaming={streaming} onSend={onSend} />, 'honestai-lang': source => <HandworkInteractiveView source={source} streaming={streaming} onSend={onSend} />, mermaid: source => <HandworkMermaid source={source} streaming={streaming} /> }}>{prepared}</Markdown>
  </StreamingText>;
}

export function toolStep(entry: Entry): ToolCall {
  const output = [entry.input ? `Input\n${entry.input}` : '', entry.text ? `Output\n${entry.text}` : ''].filter(Boolean).join('\n\n');
  return {
    id: entry.id, label: toolLabel(entry),
    outputIsCode: true,
    status: entry.status === 'completed' ? 'done' : entry.status === 'failed' ? 'error' : 'running',
    // A call with nothing to show stays a plain row instead of opening an empty well.
    output: output ? output.split('\n').map(text => ({ text })) : undefined,
  };
}

/** Where a message sits among the saved versions of its turn. */
export type MessageVersion = { index: number; total: number; onPrevious?: () => void; onNext?: () => void };

function VersionSwitcher({ version }: { version: MessageVersion }) {
  return <div className="handwork-versions" role="group" aria-label={`Version ${version.index + 1} of ${version.total}`}>
    <Button variant="link" size="icon-sm" aria-label="Previous version" title="Previous version" disabled={!version.onPrevious} onClick={version.onPrevious}><ChevronLeft aria-hidden /></Button>
    <span aria-hidden>{version.index + 1} / {version.total}</span>
    <Button variant="link" size="icon-sm" aria-label="Newer version" title="Newer version" disabled={!version.onNext} onClick={version.onNext}><ChevronRight aria-hidden /></Button>
  </div>;
}

function MessageActions({ text, user = false, onRetry, version }: { text: string; user?: boolean; onRetry?: () => void; version?: MessageVersion }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => { if (state === 'idle') return; const timer = setTimeout(() => setState('idle'), 2000); return () => clearTimeout(timer); }, [state]);
  const label = user ? 'Copy message' : 'Copy reply';
  return <div data-slot="reply-actions" className="handwork-message-actions">
    {version && <VersionSwitcher version={version} />}
    <Button variant="link" size="icon-sm" aria-label={label} title={state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Select the text to copy it.' : label} data-state={state === 'idle' ? undefined : state} onClick={() => {
      void navigator.clipboard.writeText(text).then(() => setState('copied')).catch(() => setState('failed'));
    }}>{state === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}</Button>
    {onRetry && <Button variant="link" size="icon-sm" aria-label="Try again" title="Try again. The current reply is kept as a separate chat." onClick={onRetry}><RotateCcw aria-hidden /></Button>}
    {/* Read aloud only: the check mark is the visible confirmation, so an empty status never holds a gap open in the row. */}
    <span role="status" className="sr-only">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Select the text to copy it.' : ''}</span>
  </div>;
}

const fileIcon = (name: string, mimeType?: string) => mimeType?.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name) ? FileImage
  : /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|zig|java|kt|swift|c|cc|cpp|h|cs|php|sh|json|ya?ml|toml|css|scss|html)$/i.test(name) ? FileCode : FileText;
const fileSize = (bytes?: number) => bytes === undefined ? undefined : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Files sent with a message: images as thumbnails, other files as chips. Each opens a preview. */
function MessageAttachments({ files, onOpenFile }: { files: EntryAttachment[]; onOpenFile: (file: FileTarget) => void }) {
  return <ul className="handwork-message-files" aria-label="Attachments">
    {files.map((file, index) => {
      const target: FileTarget = { name: file.name, mimeType: file.mimeType, data: file.data, target: file.uri };
      const openable = !!(file.data && file.mimeType.startsWith('image/')) || !!file.uri;
      if (file.data && file.mimeType.startsWith('image/')) return <li key={index}><button type="button" className="handwork-message-image" aria-label={`Open ${file.name}`} onClick={() => onOpenFile(target)}><img src={`data:${file.mimeType};base64,${file.data}`} alt="" /></button></li>;
      const Icon = fileIcon(file.name, file.mimeType);
      return <li key={index}><HoverTooltip content={openable ? `Open ${file.name}` : `${file.name} is not available on this computer`}><button type="button" className="handwork-file-chip" disabled={!openable}  onClick={() => onOpenFile(target)}>
        <Icon aria-hidden /><span>{file.name}</span>{fileSize(file.size) && <span className="handwork-file-chip-meta">{fileSize(file.size)}</span>}
      </button></HoverTooltip></li>;
    })}
  </ul>;
}

/** One file a turn created or changed: every edit to it, and the lines they moved. */
export type TurnFile = { path: string; added: number; removed: number; hunks: DiffLine[][] };

/** The files a run of entries changed, in the order they were first touched. */
export function turnFiles(entries: Entry[]): TurnFile[] {
  const files = new Map<string, TurnFile>();
  for (const entry of entries) for (const diff of entry.diffs ?? []) {
    const result = lineDiff(diff.oldText, diff.newText);
    const file = files.get(diff.path) ?? { path: diff.path, added: 0, removed: 0, hunks: [] };
    file.added += result.add; file.removed += result.del; file.hunks.push(result.lines);
    files.set(diff.path, file);
  }
  return [...files.values()];
}

/**
 * What a turn changed, said once, after its reply: one row per file with its
 * line counts. A row opens to the diff in place; the file itself is a click away.
 * The activity above keeps the steps; it no longer repeats the files.
 */
function ResponseFiles({ files, workspace, onOpenFile, onRevealFile }: { files: TurnFile[]; workspace?: string; onOpenFile: (file: FileTarget) => void; onRevealFile: (target: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<string>();
  const shown = expanded ? files : files.slice(0, 4);
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  return <section className="handwork-response-files" aria-label="Files changed in this response">
    {files.length > 1 && <header className="handwork-response-files-head">
      <span>{files.length} files changed</span>
      <span className="handwork-response-file-counts" aria-label={`${added} lines added, ${removed} removed`}>{added > 0 && <span data-tone="add">+{added}</span>}{removed > 0 && <span data-tone="del">−{removed}</span>}</span>
    </header>}
    <ul>
      {shown.map(file => {
        const Icon = fileIcon(file.path);
        const name = fileName(file.path);
        const absoluteFolder = file.path.slice(0, Math.max(0, file.path.length - name.length)).replace(/[\\/]$/, '');
        // Inside the project, the folder reads relative to it.
        const root = workspace?.replace(/[\\/]$/, '');
        const folder = root && (absoluteFolder === root || absoluteFolder.startsWith(`${root}/`) || absoluteFolder.startsWith(`${root}\\`)) ? absoluteFolder.slice(root.length + 1) : absoluteFolder;
        const isOpen = open === file.path;
        const hasDiff = file.hunks.some(hunk => hunk.length > 0);
        return <li key={file.path} className="handwork-response-file" data-open={isOpen || undefined}>
          <div className="handwork-response-file-row">
            <HoverTooltip content={file.path}><button type="button" className="handwork-response-file-open" aria-expanded={hasDiff ? isOpen : undefined}
              aria-label={hasDiff ? `${isOpen ? 'Hide' : 'Show'} changes to ${name}` : `Open ${name}`}
              onClick={() => hasDiff ? setOpen(isOpen ? undefined : file.path) : onOpenFile({ name, target: file.path })}>
              <Icon aria-hidden /><span className="handwork-response-file-name">{name}</span>{folder && <span className="handwork-response-file-folder">{folder}</span>}
              {(file.added > 0 || file.removed > 0) && <span className="handwork-response-file-counts" aria-hidden>{file.added > 0 && <span data-tone="add">+{file.added}</span>}{file.removed > 0 && <span data-tone="del">−{file.removed}</span>}</span>}
              {hasDiff && <ChevronDown className="handwork-response-file-chevron" aria-hidden />}
            </button></HoverTooltip>
            <span className="handwork-response-file-actions">
              <Button variant="ghost" size="icon-sm" aria-label={`Open ${name}`} title="Open file" onClick={() => onOpenFile({ name, target: file.path })}><ExternalLink aria-hidden /></Button>
              <Button variant="ghost" size="icon-sm" aria-label={`${revealLabel}: ${name}`} title={revealLabel} onClick={() => onRevealFile(file.path)}><FolderOpen aria-hidden /></Button>
            </span>
          </div>
          {isOpen && <div className="handwork-response-file-diff" role="region" aria-label={`Changes to ${name}`}>
            {file.hunks.filter(hunk => hunk.length).map((hunk, index) => <pre key={index}>{hunk.map((line, row) => <span key={row} data-tone={line.tone}>{line.text || ' '}</span>)}</pre>)}
          </div>}
        </li>;
      })}
    </ul>
    {files.length > 4 && <Button variant="ghost" size="sm" className="handwork-response-files-more" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer' : `Show ${files.length - 4} more`}</Button>}
  </section>;
}

export function ThoughtText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return <ThinkingText><Markdown className="handwork-thought-prose" syntaxHighlighting syntaxPalette="violet" isStreaming={streaming} remarkPlugins={mathPlugins.remarkPlugins} rehypePlugins={mathPlugins.rehypePlugins}>{prepareMath(text, streaming)}</Markdown></ThinkingText>;
}

function ResponseActivity({ entries, active }: { entries: Entry[]; active: boolean }) {
  const tools = entries.filter(entry => entry.kind === 'tool');
  const running = tools.findLast(entry => entry.status !== 'completed' && entry.status !== 'failed');
  const steps = tools.length || entries.length;
  // The files it changed are listed once, under the reply, so the summary only counts steps.
  const summary = `${active ? running ? toolLabel(running) : 'Working…' : 'View activity'} · ${steps} step${steps === 1 ? '' : 's'}`;
  const groups: ({ kind: 'tools'; entries: Entry[] } | { kind: 'entry'; entry: Entry })[] = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    if (entry.kind === 'tool' && previous?.kind === 'tools') previous.entries.push(entry);
    else if (entry.kind === 'tool') groups.push({ kind: 'tools', entries: [entry] });
    else groups.push({ kind: 'entry', entry });
  }
  return <details className="handwork-response-activity" data-slot="response-activity" data-active={active || undefined}>
    <summary><ChevronDown aria-hidden /><span>{summary}</span></summary>
    <div className="handwork-activity-history">
      {groups.map(group => {
        if (group.kind === 'tools') return <ToolChips key={group.entries[0].id} summary={`${group.entries.length} tool call${group.entries.length === 1 ? '' : 's'}`} calls={group.entries.map(toolStep)} />;
        const entry = group.entry;
        if (entry.kind === 'reasoning') return <ThinkingState key={entry.id} status="done" label="Thought"><ThoughtText text={entry.text} streaming={active && entry === entries.at(-1)} /></ThinkingState>;
        return <div key={entry.id} className="handwork-activity-note">{entry.text}</div>;
      })}
    </div>
  </details>;
}

export default function HandworkTranscript({ entries, busy, onSend, onEdit, onRetry, versionFor, onOpenFile, onRevealFile, workspace, recovery, canContinue, onContinue, continuationDisabled }: {
  entries: Entry[]; busy: boolean; onSend: (text: string) => Promise<void>; onEdit: (id: string, text: string) => Promise<void>;
  /** Offered on the latest reply when it can be regenerated. */
  onRetry?: () => void;
  recovery?: string; canContinue?: boolean; onContinue?: () => void; continuationDisabled?: boolean;
  /** Other saved versions of a user turn, made by editing or retrying it. Turns count user messages from 0. */
  versionFor?: (turn: number) => MessageVersion | undefined;
  onOpenFile: (file: FileTarget) => void; onRevealFile: (target: string) => void;
  /** The project folder, so file paths can read relative to it. */
  workspace?: string;
}) {
  const blocks = transcriptBlocks(entries, busy);
  const lastReply = blocks.findLastIndex(block => block.kind === 'entry' && block.entry.kind === 'assistant');
  const lastUser = blocks.findLastIndex(block => block.kind === 'entry' && block.entry.kind === 'user');
  const turns = new Map(entries.filter(entry => entry.kind === 'user').map((entry, turn) => [entry.id, turn]));
  // Each finished turn lists the files it changed once, at its end: inside its
  // last reply when it closes on one, otherwise after its last block.
  const filesAt = new Map<number, TurnFile[]>();
  let turnStart = 0;
  blocks.forEach((block, index) => {
    const next = blocks[index + 1];
    if (next && !(next.kind === 'entry' && next.entry.kind === 'user')) return;
    const live = busy && !next;
    const files = live ? [] : turnFiles(blocks.slice(turnStart, index + 1).flatMap(item => item.kind === 'activity' ? item.entries : []));
    if (files.length) filesAt.set(index, files);
    turnStart = index + 1;
  });
  const changedFiles = (index: number) => {
    const files = filesAt.get(index);
    return files ? <ResponseFiles files={files} workspace={workspace} onOpenFile={onOpenFile} onRevealFile={onRevealFile} /> : null;
  };
  return <div className="handwork-transcript">
    {blocks.map((block, index) => {
      const streaming = busy && index === blocks.length - 1;
      if (block.kind === 'activity') return <div key={`activity-${block.entries[0].id}`} className="handwork-response-work">
        <ResponseActivity entries={block.entries} active={block.active} />
        {changedFiles(index)}
      </div>;
      const entry = block.entry;
      if (entry.kind === 'assistant' && isResponseError(entry.text)) {
        // The checkpoint card below owns the current failure; old failures stay in history.
        if ((recovery || busy) && index > lastUser) return null;
        return <Fragment key={entry.id}><HandworkResponseError detail={entry.text} />{changedFiles(index)}</Fragment>;
      }
      const submission = entry.kind === 'user' ? actionSubmission(entry.text) : null;
      const userText = submission ? `${submission.message}\n\n${submission.fields.map(field => `${field.label}: ${field.value}`).join('\n')}` : entry.text;
      const generatedSource = entry.kind === 'assistant' ? bareGenuiSource(entry.text) : null;
      if (entry.kind === 'reasoning') return <ThinkingState key={entry.id} status={streaming ? 'running' : 'done'} label={streaming ? 'Thinking' : 'Thought'}><ThoughtText text={entry.text} streaming={streaming} /></ThinkingState>;
      const files: ReactNode = entry.kind === 'assistant' ? changedFiles(index) : null;
      return <div key={entry.id} data-slot="message" data-from={entry.kind === 'user' ? 'user' : 'assistant'}>
        {/* Files sit above the bubble, so the bubble only wraps the words. */}
        {entry.attachments?.length ? <MessageAttachments files={entry.attachments} onOpenFile={onOpenFile} /> : null}
        <ChatMessage role={entry.kind === 'user' ? 'user' : 'assistant'} author={entry.kind === 'user' ? 'You' : 'Handwork'} hideAuthor className={entry.kind === 'user' ? 'handwork-message handwork-editable-message' : 'handwork-message'}
        editText={entry.kind === 'user' && !entry.attachments?.length && !busy ? userText : undefined}
        onEdit={entry.kind === 'user' && !entry.attachments?.length && !busy ? edited => onEdit(entry.id, edited) : undefined}
        labels={{ resend: 'Save & regenerate', editError: 'The message could not be regenerated. Your edit is preserved. Try again.' }}
        footer={entry.kind === 'user' ? <MessageActions text={userText} user version={versionFor?.(turns.get(entry.id) ?? -1)} /> : undefined}
>
        {entry.kind === 'user' ? <div data-slot="message-content" className="handwork-user-text">{submission ? <div className="handwork-submission">
          <p>{submission.message}</p>
          <dl className="handwork-submission-fields" aria-label="Submitted preferences">{submission.fields.map((field, index) => <div key={index}>
            <dt>{field.label}</dt><dd>{field.value || <span className="handwork-submission-empty">Not specified</span>}</dd>
          </div>)}</dl>
        </div> : entry.text}</div> : <>
          <div data-slot="message-content">{generatedSource ? <HandworkInteractiveView source={generatedSource} streaming={streaming} onSend={onSend} /> : <AssistantReply text={entry.text} streaming={streaming} onSend={onSend} onOpenFile={onOpenFile} />}</div>
          {files}
          {/* Earlier replies keep their actions while a new turn runs, so nothing above the live edge shifts. */}
          {!streaming && entry.text && <MessageActions text={entry.text} onRetry={!busy && index === lastReply && lastReply > lastUser ? onRetry : undefined} />}
        </>}
      </ChatMessage></div>;
    })}
    {recovery && (!busy || canContinue ? <HandworkResponseError detail={recovery} onContinue={canContinue ? onContinue : undefined} disabled={busy || continuationDisabled} />
      : <div role="status" className="handwork-notice" data-attention="recovery">{recovery}</div>)}
  </div>;
}
