"use client";

import { useEffect, useState } from 'react';
import HandworkInteractiveView from './HandworkInteractiveView';
import { ChatMessage } from '@/components/ui/chat-thread';
import { Markdown } from 'honestui/ai/markdown';
import { ThinkingState, ThinkingText } from 'honestui/ai/thinking-state';
import { ToolChips, type ToolCall, type FileChange } from 'honestui/ai/tool-chips';
import { Check, ChevronDown, Copy } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import type { Entry } from '@/lib/desktop-state';
import { lineDiff } from '@/lib/line-diff';
import { transcriptBlocks, toolLabel } from '@/lib/transcript-activity';
import { bareGenuiSource } from '@/lib/genui-response';

export function toolStep(entry: Entry): ToolCall {
  return {
    id: entry.id, label: toolLabel(entry),
    outputIsCode: true,
    status: entry.status === 'completed' ? 'done' : entry.status === 'failed' ? 'error' : 'running',
    output: [entry.input ? `Input\n${entry.input}` : '', entry.text ? `Output\n${entry.text}` : ''].filter(Boolean).join('\n\n').split('\n').map(text => ({ text })),
  };
}

function MessageActions({ text, user = false }: { text: string; user?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => { if (state === 'idle') return; const timer = setTimeout(() => setState('idle'), 2000); return () => clearTimeout(timer); }, [state]);
  const label = user ? 'Copy message' : 'Copy reply';
  return <div data-slot="reply-actions" className="handwork-message-actions">
    <Button variant="link" size="icon-sm" aria-label={label} title={label} onClick={() => {
      void navigator.clipboard.writeText(text).then(() => setState('copied')).catch(() => setState('failed'));
    }}>{state === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}</Button>
    <span role="status">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Select the text to copy it.' : ''}</span>
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

export default function HandworkTranscript({ entries, busy, onSend, onEdit }: { entries: Entry[]; busy: boolean; onSend: (text: string) => Promise<void>; onEdit: (id: string, text: string) => Promise<void> }) {
  const blocks = transcriptBlocks(entries, busy);
  return <div className="handwork-transcript">
    {blocks.map((block, index) => {
      const streaming = busy && index === blocks.length - 1;
      if (block.kind === 'activity') return <ResponseActivity key={`activity-${block.entries[0].id}`} entries={block.entries} active={block.active} />;
      const entry = block.entry;
      const generatedSource = entry.kind === 'assistant' ? bareGenuiSource(entry.text) : null;
      if (entry.kind === 'reasoning') return <ThinkingState key={entry.id} status={streaming ? 'running' : 'done'} label={streaming ? 'Thinking' : 'Thought'}><ThinkingText>{entry.text}</ThinkingText></ThinkingState>;
      return <div key={entry.id} data-slot="message" data-from={entry.kind === 'user' ? 'user' : 'assistant'}><ChatMessage role={entry.kind === 'user' ? 'user' : 'assistant'} author={entry.kind === 'user' ? 'You' : 'Handwork'} hideAuthor className={entry.kind === 'user' ? 'handwork-message handwork-editable-message' : 'handwork-message'}
        editText={entry.kind === 'user' && !entry.attachments?.length && !busy ? entry.text : undefined}
        onEdit={entry.kind === 'user' && !entry.attachments?.length && !busy ? edited => onEdit(entry.id, edited) : undefined}
        labels={{ resend: 'Save & regenerate', editError: 'The message could not be regenerated. Your edit is preserved. Try again.' }}
        footer={entry.kind === 'user' ? <MessageActions text={entry.text} user /> : undefined}
        attachments={entry.attachments?.map(file => ({ name: file.name, meta: `${Math.max(1, Math.round(file.size / 1024))} KB` }))}>
        {entry.kind === 'user' ? <div data-slot="message-content" className="handwork-user-text">{entry.text}</div> : <>
          <div data-slot="message-content">{generatedSource ? <HandworkInteractiveView source={generatedSource} streaming={streaming} onSend={onSend} /> : <Markdown syntaxHighlighting syntaxPalette="violet" isStreaming={streaming} components={{ a: ({ children, href }) => <span title={href}>{children} {href && <small>({href})</small>}</span>, img: ({ alt }) => <span>[Image: {alt || 'remote image not loaded'}]</span> }}
            blocks={{ honestai: source => <HandworkInteractiveView source={source} streaming={streaming} onSend={onSend} />, 'honestai-lang': source => <HandworkInteractiveView source={source} streaming={streaming} onSend={onSend} /> }}>{entry.text}</Markdown>}</div>
          {!busy && entry.text && <MessageActions text={entry.text} />}
        </>}
      </ChatMessage></div>;
    })}
  </div>;
}
