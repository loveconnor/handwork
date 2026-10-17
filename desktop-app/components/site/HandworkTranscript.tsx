"use client";

import { useEffect, useMemo, useState } from 'react';
import HandworkInteractiveView from './HandworkInteractiveView';
import { ChatMessage } from '@/components/ui/chat-thread';
import { Markdown } from 'honestui/ai/markdown';
import { mathPlugins } from 'honestui/ai/markdown-math';
import { prepareMath } from '@/lib/markdown-math';
import { HandworkMermaid } from '@/components/site/HandworkMermaid';
import { ThinkingState, ThinkingText } from 'honestui/ai/thinking-state';
import { ToolChips, type ToolCall, type FileChange } from 'honestui/ai/tool-chips';
import { StreamingText, StreamingCitation } from 'honestui/ai/streaming-text';
import { Check, ChevronDown, Copy, RotateCcw, FileText, FileImage, FileCode, FolderOpen } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import type { Entry, EntryAttachment } from '@/lib/desktop-state';
import type { FileTarget } from '@/components/site/HandworkFileViewer';
import { revealLabel } from '@/components/site/HandworkFileViewer';
import { lineDiff } from '@/lib/line-diff';
import { transcriptBlocks, toolLabel } from '@/lib/transcript-activity';
import { bareGenuiSource } from '@/lib/genui-response';
import { actionSubmission } from '@/lib/genui-action';
import { replySources, sourceUrl } from '@/lib/reply-sources';

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
        if (local) return <button type="button" className="handwork-file-link" title={local} onClick={() => onOpenFile({ name: fileName(local), target: local })}>{children}</button>;
        if (!url) return <span>{children}</span>;
        const source = sources.find(item => item.href === url);
        return <StreamingCitation href={url} title={source?.title || url} target="_blank" rel="noopener noreferrer">{source && source.title === source.domain ? source.domain : children}</StreamingCitation>;
      },
      img: ({ alt }) => <span>[Image: {alt || 'remote image not loaded'}]</span>,
    }} blocks={{ honestai: source => <HandworkInteractiveView source={source} streaming={streaming} onSend={onSend} />, 'honestai-lang': source => <HandworkInteractiveView source={source} streaming={streaming} onSend={onSend} />, mermaid: source => <HandworkMermaid source={source} streaming={streaming} /> }}>{prepared}</Markdown>
  </StreamingText>;
}

export function toolStep(entry: Entry): ToolCall {
  return {
    id: entry.id, label: toolLabel(entry),
    outputIsCode: true,
    status: entry.status === 'completed' ? 'done' : entry.status === 'failed' ? 'error' : 'running',
    output: [entry.input ? `Input\n${entry.input}` : '', entry.text ? `Output\n${entry.text}` : ''].filter(Boolean).join('\n\n').split('\n').map(text => ({ text })),
  };
}

function MessageActions({ text, user = false, onRetry }: { text: string; user?: boolean; onRetry?: () => void }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => { if (state === 'idle') return; const timer = setTimeout(() => setState('idle'), 2000); return () => clearTimeout(timer); }, [state]);
  const label = user ? 'Copy message' : 'Copy reply';
  return <div data-slot="reply-actions" className="handwork-message-actions">
    <Button variant="link" size="icon-sm" aria-label={label} title={label} onClick={() => {
      void navigator.clipboard.writeText(text).then(() => setState('copied')).catch(() => setState('failed'));
    }}>{state === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}</Button>
    {onRetry && <Button variant="link" size="icon-sm" aria-label="Try again" title="Try again. The current reply is kept as a separate chat." onClick={onRetry}><RotateCcw aria-hidden /></Button>}
    <span role="status">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Select the text to copy it.' : ''}</span>
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
      return <li key={index}><button type="button" className="handwork-file-chip" disabled={!openable} title={openable ? `Open ${file.name}` : `${file.name} is not available on this computer`} onClick={() => onOpenFile(target)}>
        <Icon aria-hidden /><span>{file.name}</span>{fileSize(file.size) && <span className="handwork-file-chip-meta">{fileSize(file.size)}</span>}
      </button></li>;
    })}
  </ul>;
}

/** Files a response created or changed, ready to open. */
function ResponseFiles({ paths, workspace, onOpenFile, onRevealFile }: { paths: string[]; workspace?: string; onOpenFile: (file: FileTarget) => void; onRevealFile: (target: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? paths : paths.slice(0, 4);
  return <div className="handwork-response-files" role="group" aria-label="Files from this response">
    {shown.map(path => {
      const Icon = fileIcon(path);
      const name = fileName(path);
      const absoluteFolder = path.slice(0, Math.max(0, path.length - name.length)).replace(/[\\/]$/, '');
      // Inside the project, the folder reads relative to it.
      const root = workspace?.replace(/[\\/]$/, '');
      const folder = root && (absoluteFolder === root || absoluteFolder.startsWith(`${root}/`) || absoluteFolder.startsWith(`${root}\\`)) ? absoluteFolder.slice(root.length + 1) : absoluteFolder;
      return <div key={path} className="handwork-response-file">
        <button type="button" className="handwork-response-file-open" title={path} onClick={() => onOpenFile({ name, target: path })}>
          <Icon aria-hidden /><span className="handwork-response-file-name">{name}</span>{folder && <span className="handwork-response-file-folder">{folder}</span>}
        </button>
        <Button variant="ghost" size="icon-sm" aria-label={`${revealLabel}: ${name}`} title={revealLabel} onClick={() => onRevealFile(path)}><FolderOpen aria-hidden /></Button>
      </div>;
    })}
    {paths.length > 4 && <Button variant="ghost" size="sm" className="handwork-response-files-more" onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer' : `Show ${paths.length - 4} more`}</Button>}
  </div>;
}

function ResponseActivity({ entries, active }: { entries: Entry[]; active: boolean }) {
  const tools = entries.filter(entry => entry.kind === 'tool');
  const running = tools.findLast(entry => entry.status !== 'completed' && entry.status !== 'failed');
  const paths = new Set(tools.flatMap(entry => (entry.diffs ?? []).map(diff => diff.path)));
  const steps = tools.length || entries.length;
  const summary = `${active ? running ? toolLabel(running) : 'Working…' : 'View activity'} · ${steps} step${steps === 1 ? '' : 's'}${paths.size ? ` · ${paths.size} file${paths.size === 1 ? '' : 's'} edited` : ''}`;
  const groups: ({ kind: 'tools'; entries: Entry[] } | { kind: 'entry'; entry: Entry })[] = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    if (entry.kind === 'tool' && previous?.kind === 'tools') previous.entries.push(entry);
    else if (entry.kind === 'tool') groups.push({ kind: 'tools', entries: [entry] });
    else groups.push({ kind: 'entry', entry });
  }
  return <details className="handwork-response-activity" data-slot="response-activity">
    <summary><ChevronDown aria-hidden /><span>{summary}</span></summary>
    <div className="handwork-activity-history">
      {groups.map(group => {
        if (group.kind === 'tools') {
          const changes: FileChange[] = group.entries.flatMap(entry => (entry.diffs ?? []).map(diff => {
            const result = lineDiff(diff.oldText, diff.newText);
            return { path: diff.path, added: result.add, removed: result.del, lines: result.lines.map(line => ({ text: line.text, kind: line.tone === 'add' ? 'added' : line.tone === 'del' ? 'removed' : 'context' })) };
          }));
          return <ToolChips key={group.entries[0].id} summary={`${group.entries.length} tool call${group.entries.length === 1 ? '' : 's'}`} calls={group.entries.map(toolStep)} changes={changes} />;
        }
        const entry = group.entry;
        if (entry.kind === 'reasoning') return <ThinkingState key={entry.id} status="done" label="Thought"><ThinkingText>{entry.text}</ThinkingText></ThinkingState>;
        return <div key={entry.id} className="handwork-activity-note">{entry.text}</div>;
      })}
    </div>
  </details>;
}

export default function HandworkTranscript({ entries, busy, onSend, onEdit, onRetry, onOpenFile, onRevealFile, workspace }: {
  entries: Entry[]; busy: boolean; onSend: (text: string) => Promise<void>; onEdit: (id: string, text: string) => Promise<void>;
  /** Offered on the latest reply when it can be regenerated. */
  onRetry?: () => void;
  onOpenFile: (file: FileTarget) => void; onRevealFile: (target: string) => void;
  /** The project folder, so file paths can read relative to it. */
  workspace?: string;
}) {
  const blocks = transcriptBlocks(entries, busy);
  const lastReply = blocks.findLastIndex(block => block.kind === 'entry' && block.entry.kind === 'assistant');
  const lastUser = blocks.findLastIndex(block => block.kind === 'entry' && block.entry.kind === 'user');
  return <div className="handwork-transcript">
    {blocks.map((block, index) => {
      const streaming = busy && index === blocks.length - 1;
      if (block.kind === 'activity') {
        const paths = [...new Set(block.entries.flatMap(entry => (entry.diffs ?? []).map(diff => diff.path)))];
        return <div key={`activity-${block.entries[0].id}`} className="handwork-response-work">
          <ResponseActivity entries={block.entries} active={block.active} />
          {!block.active && paths.length > 0 && <ResponseFiles paths={paths} workspace={workspace} onOpenFile={onOpenFile} onRevealFile={onRevealFile} />}
        </div>;
      }
      const entry = block.entry;
      const submission = entry.kind === 'user' ? actionSubmission(entry.text) : null;
      const userText = submission ? `${submission.message}\n\n${submission.fields.map(field => `${field.label}: ${field.value}`).join('\n')}` : entry.text;
      const generatedSource = entry.kind === 'assistant' ? bareGenuiSource(entry.text) : null;
      if (entry.kind === 'reasoning') return <ThinkingState key={entry.id} status={streaming ? 'running' : 'done'} label={streaming ? 'Thinking' : 'Thought'}><ThinkingText>{entry.text}</ThinkingText></ThinkingState>;
      return <div key={entry.id} data-slot="message" data-from={entry.kind === 'user' ? 'user' : 'assistant'}>
        {/* Files sit above the bubble, so the bubble only wraps the words. */}
        {entry.attachments?.length ? <MessageAttachments files={entry.attachments} onOpenFile={onOpenFile} /> : null}
        <ChatMessage role={entry.kind === 'user' ? 'user' : 'assistant'} author={entry.kind === 'user' ? 'You' : 'Handwork'} hideAuthor className={entry.kind === 'user' ? 'handwork-message handwork-editable-message' : 'handwork-message'}
        editText={entry.kind === 'user' && !entry.attachments?.length && !busy ? userText : undefined}
        onEdit={entry.kind === 'user' && !entry.attachments?.length && !busy ? edited => onEdit(entry.id, edited) : undefined}
        labels={{ resend: 'Save & regenerate', editError: 'The message could not be regenerated. Your edit is preserved. Try again.' }}
        footer={entry.kind === 'user' ? <MessageActions text={userText} user /> : undefined}
>
        {entry.kind === 'user' ? <div data-slot="message-content" className="handwork-user-text">{submission ? <div className="handwork-submission">
          <p>{submission.message}</p>
          <dl className="handwork-submission-fields" aria-label="Submitted preferences">{submission.fields.map((field, index) => <div key={index}>
            <dt>{field.label}</dt><dd>{field.value || <span className="handwork-submission-empty">Not specified</span>}</dd>
          </div>)}</dl>
        </div> : entry.text}</div> : <>
          <div data-slot="message-content">{generatedSource ? <HandworkInteractiveView source={generatedSource} streaming={streaming} onSend={onSend} /> : <AssistantReply text={entry.text} streaming={streaming} onSend={onSend} onOpenFile={onOpenFile} />}</div>
          {!busy && entry.text && <MessageActions text={entry.text} onRetry={index === lastReply && lastReply > lastUser ? onRetry : undefined} />}
        </>}
      </ChatMessage></div>;
    })}
  </div>;
}
