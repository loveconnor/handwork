"use client";

import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { BookText, Plus, Search, Pencil, Trash2, CornerDownLeft, GitPullRequest, CalendarDays, Lightbulb } from 'honestui/icons';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { DesktopAPI, SavedPrompt, SavedPromptInput } from '@/lib/desktop-api';
import { humanizeVariable, matchScore, promptSlug, promptVariables, fillPrompt, promptParts } from '@/lib/saved-prompts';

// The Honest AI renderer is large; load it only when a prompt has fields.
const PromptForm = lazy(() => import('./HandworkPromptForm'));
const formFallback = <p className="handwork-settings-note" role="status">Loading fields…</p>;

const composerInput = () => document.querySelector<HTMLElement>('[data-slot="prompt-bar-input"]');
type Draft = { id?: string; title: string; folder: string; text: string };
// Starting points for an empty library. Each opens the editor filled in; nothing is saved until the person saves it.
const starters = [
  { icon: GitPullRequest, title: 'Review a change', folder: 'Code', text: 'Review this change for correctness, edge cases, and readability. List issues by severity, then suggest the smallest fix for each.\n\n{{change}}' },
  { icon: Lightbulb, title: 'Explain this code', folder: 'Code', text: 'Explain how {{file_or_function}} works to someone new to this codebase. Start with what it is for, walk through the main path, then point out anything surprising.' },
  { icon: CalendarDays, title: 'Weekly summary', folder: 'Writing', text: 'Summarize this week in {{project}} for {{audience}}. Lead with outcomes, then risks, then next steps. Keep it under 200 words.' },
];
const message = (cause: unknown) => cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause);

/** A searchable library of reusable prompts, grouped by folder. */
export function HandworkPromptLibrary({ open, onOpenChange, api, prompts, onPromptsChange, onUse, newDraft }: {
  open: boolean; onOpenChange: (open: boolean) => void; api?: DesktopAPI;
  prompts: SavedPrompt[]; onPromptsChange: (prompts: SavedPrompt[]) => void;
  onUse: (prompt: SavedPrompt) => void;
  /** Opens the editor with this text, as "Save as prompt" does. */
  newDraft?: string;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) { setDraft(undefined); setConfirmDelete(false); setError(''); setQuery(''); return; }
    if (newDraft !== undefined) setDraft({ title: '', folder: '', text: newDraft });
  }, [open, newDraft]);
  const editing = !!draft; const editingId = draft?.id;
  useEffect(() => { if (editing) requestAnimationFrame(() => document.getElementById('handwork-prompt-title')?.focus()); }, [editing, editingId]);

  const visible = useMemo(() => prompts
    .map(prompt => ({ prompt, score: matchScore(`${prompt.title} ${prompt.folder} ${prompt.text}`, query) }))
    .filter(item => item.score > 0)
    .sort((a, b) => a.prompt.folder.localeCompare(b.prompt.folder) || (query ? b.score - a.score : 0) || a.prompt.title.localeCompare(b.prompt.title))
    .map(item => item.prompt), [prompts, query]);
  const folders = useMemo(() => [...new Set(prompts.map(prompt => prompt.folder).filter(Boolean))].sort(), [prompts]);
  const current = prompts.find(prompt => prompt.id === selected) ?? (draft ? undefined : visible[0]);
  const variables = current ? promptVariables(current.text) : [];
  const draftVariables = draft ? promptVariables(draft.text) : [];
  const duplicateSlug = draft && draft.title.trim() && prompts.some(prompt => prompt.id !== draft.id && promptSlug(prompt) === promptSlug({ title: draft.title }));

  async function save() {
    if (!api || !draft || saving) return;
    setSaving(true); setError('');
    try {
      const input: SavedPromptInput = { ...(draft.id ? { id: draft.id } : {}), title: draft.title.trim(), folder: draft.folder.trim(), text: draft.text };
      const saved = await api.savePrompt(input);
      onPromptsChange(prompts.some(prompt => prompt.id === saved.id) ? prompts.map(prompt => prompt.id === saved.id ? saved : prompt) : [...prompts, saved]);
      setSelected(saved.id); setDraft(undefined);
    } catch (cause) { setError(message(cause)); }
    finally { setSaving(false); }
  }
  async function remove() {
    if (!api || !current || saving) return;
    setSaving(true); setError('');
    try {
      await api.deletePrompt(current.id);
      onPromptsChange(prompts.filter(prompt => prompt.id !== current.id));
      setSelected(''); setConfirmDelete(false);
    } catch (cause) { setError(message(cause)); }
    finally { setSaving(false); }
  }

  // An empty library has nothing to list, so it drops the sidebar and sizes to its content.
  const empty = prompts.length === 0;
  let lastFolder: string | undefined;
  return <Dialog open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }}>
    <DialogContent className="handwork-settings handwork-settings-v2 handwork-prompts" data-empty={empty && !draft ? '' : undefined} showCloseButton={!saving} finalFocus={() => document.querySelector<HTMLElement>('.handwork-prompt-fill :is(input, textarea)') ?? composerInput()}>
      <DialogHeader><DialogTitle>Saved prompts</DialogTitle><DialogDescription>Reuse prompts you write often. Type <kbd>/</kbd> in the composer to insert one.</DialogDescription></DialogHeader>
      <div className="handwork-settings-layout">
        {!empty && <div className="handwork-prompt-sidebar">
          {prompts.length > 0 && <div className="handwork-prompt-search">
            <Search aria-hidden width={14} height={14} />
            <input type="search" aria-label="Search saved prompts" placeholder="Search prompts" value={query} onChange={event => setQuery(event.target.value)} />
          </div>}
          <div className="handwork-prompt-list" role="listbox" aria-label="Saved prompts">
            {visible.map(prompt => {
              const heading = prompt.folder !== lastFolder && (prompt.folder || folders.length > 0) ? <div className="handwork-prompt-folder" role="presentation">{prompt.folder || 'Unfiled'}</div> : null;
              lastFolder = prompt.folder;
              return <div key={prompt.id} role="presentation">{heading}<button type="button" role="option" aria-selected={!draft && current?.id === prompt.id} className="handwork-prompt-item" onClick={() => { setSelected(prompt.id); setDraft(undefined); setConfirmDelete(false); setError(''); }} onDoubleClick={() => onUse(prompt)}>
                <span className="handwork-prompt-item-title">{prompt.title}</span>
                <span className="handwork-prompt-item-preview">{prompt.text.replace(/\s+/g, ' ').slice(0, 90)}</span>
              </button></div>;
            })}
            {!visible.length && prompts.length > 0 && <p className="handwork-prompt-empty-list">No prompts match “{query}”.</p>}
          </div>
          {(prompts.length > 0 || draft) && <Button variant="ghost" size="sm" className="handwork-prompt-new" disabled={!api || saving} onClick={() => { setDraft({ title: '', folder: current?.folder ?? '', text: '' }); setConfirmDelete(false); setError(''); }}><Plus aria-hidden width={14} height={14} />New prompt</Button>}
        </div>}
        <DialogBody className="handwork-settings-panel handwork-prompt-panel">
          {error && <p role="alert" className="handwork-prompt-error">{error}</p>}
          {draft ? <form className="handwork-prompt-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
            <h2>{draft.id ? 'Edit prompt' : 'New prompt'}</h2>
            <div className="handwork-prompt-fields">
              <label>Name<Input id="handwork-prompt-title" value={draft.title} maxLength={120} required placeholder="Review this pull request" disabled={saving} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
              <label>Folder<Input value={draft.folder} maxLength={60} placeholder="Optional" list="handwork-prompt-folders" disabled={saving} onChange={event => setDraft({ ...draft, folder: event.target.value })} /></label>
              <datalist id="handwork-prompt-folders">{folders.map(folder => <option key={folder} value={folder} />)}</datalist>
            </div>
            {draft.title.trim() && <p className="handwork-settings-note">Insert it with <code>/{promptSlug({ title: draft.title })}</code>{duplicateSlug ? '. Another prompt uses this name too; both will appear.' : '.'}</p>}
            <label className="handwork-prompt-body-label" htmlFor="handwork-prompt-body">Prompt</label>
            <Textarea id="handwork-prompt-body" value={draft.text} required rows={10} disabled={saving} placeholder={'Summarize {{topic}} for {{audience}} in three bullet points.'} onChange={event => setDraft({ ...draft, text: event.target.value })}
              onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }} />
            <p className="handwork-settings-note">Wrap details that change in double braces, like <code>{'{{topic}}'}</code>. You’ll fill them in when you use the prompt.</p>
            {draftVariables.length > 0 && <section className="handwork-prompt-form-preview" aria-label="Fields you will fill in">
              <span>When you use it, you’ll fill in</span>
              <Suspense fallback={formFallback}><PromptForm names={draftVariables} preview /></Suspense>
            </section>}
            <div className="handwork-settings-buttons"><Button type="submit" size="sm" disabled={saving || !draft.title.trim() || !draft.text.trim()}>{saving ? 'Saving…' : 'Save prompt'}</Button><Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(undefined)}>Cancel</Button></div>
          </form> : current ? <article className="handwork-prompt-detail">
            <header>
              <div><h2>{current.title}</h2><p><code>/{promptSlug(current)}</code>{current.folder && <> · {current.folder}</>}</p></div>
              <div className="handwork-prompt-detail-actions">
                <Button variant="ghost" size="icon-sm" aria-label="Edit prompt" title="Edit prompt" disabled={saving} onClick={() => { setDraft({ id: current.id, title: current.title, folder: current.folder, text: current.text }); setConfirmDelete(false); }}><Pencil aria-hidden width={14} height={14} /></Button>
                <Button variant="ghost" size="icon-sm" aria-label="Delete prompt" title="Delete prompt" disabled={saving} onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden width={14} height={14} /></Button>
              </div>
            </header>
            <div className="handwork-prompt-preview">{current.text}</div>
            {variables.length > 0 && <p className="handwork-settings-note">You’ll be asked for: {variables.map(name => <span key={name} className="handwork-prompt-variable">{humanizeVariable(name)}</span>)}</p>}
            {confirmDelete && <div className="handwork-settings-callout" role="alertdialog" aria-label="Delete prompt?"><p>Delete “{current.title}”? This cannot be undone.</p><div className="handwork-settings-buttons"><Button size="sm" variant="destructive" disabled={saving} onClick={() => void remove()}>{saving ? 'Deleting…' : 'Delete prompt'}</Button><Button size="sm" variant="ghost" disabled={saving} onClick={() => setConfirmDelete(false)}>Keep</Button></div></div>}
          </article> : <div className="handwork-prompt-blank">
            <span className="handwork-prompt-blank-icon"><BookText aria-hidden width={20} height={20} /></span>
            <h2>No saved prompts yet</h2>
            <p>Save instructions you repeat, like a review checklist. Parts that change, like <code>{'{{topic}}'}</code>, are filled in each time you use one.</p>
            <Button size="sm" disabled={!api} onClick={() => setDraft({ title: '', folder: '', text: '' })}><Plus aria-hidden width={14} height={14} />New prompt</Button>
            <div className="handwork-prompt-starters" role="group" aria-labelledby="handwork-prompt-starters-label">
              <span id="handwork-prompt-starters-label">Or start from an example</span>
              <ul>{starters.map(starter => <li key={starter.title}><button type="button" className="handwork-prompt-starter" disabled={!api} onClick={() => setDraft({ title: starter.title, folder: starter.folder, text: starter.text })}>
                <starter.icon aria-hidden width={15} height={15} />
                <span><span className="handwork-prompt-item-title">{starter.title}</span><span className="handwork-prompt-item-preview">{starter.text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => `[${humanizeVariable(name).toLowerCase()}]`).replace(/\s+/g, ' ')}</span></span>
              </button></li>)}</ul>
            </div>
          </div>}
        </DialogBody>
      </div>
      {!draft && current && <DialogFooter className="handwork-prompt-footer"><span className="handwork-settings-note">Double-click a prompt to insert it.</span><Button size="sm" onClick={() => onUse(current)}><CornerDownLeft aria-hidden width={14} height={14} />Insert prompt</Button></DialogFooter>}
    </DialogContent>
  </Dialog>;
}

/** Asks for each `{{variable}}` before a saved prompt reaches the composer. */
export function PromptFillDialog({ prompt, onCancel, onInsert }: { prompt?: SavedPrompt; onCancel: () => void; onInsert: (text: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => { setValues({}); }, [prompt?.id]);
  const names = prompt ? promptVariables(prompt.text) : [];
  const filled = names.filter(name => values[name]?.trim()).length;
  const insert = () => { if (prompt) onInsert(fillPrompt(prompt.text, values)); };
  return <Dialog open={!!prompt} onOpenChange={open => { if (!open) onCancel(); }}>
    <DialogContent className="handwork-chat-dialog handwork-prompt-fill" finalFocus={composerInput}>
      <DialogHeader><DialogTitle>{prompt?.title}</DialogTitle><DialogDescription>Fill in the details, then insert the prompt into your message. Anything left empty stays as a placeholder you can edit.</DialogDescription></DialogHeader>
      {/* ⌘/Ctrl+Enter inserts from any field; plain Enter keeps adding lines in longer answers. */}
      <DialogBody className="handwork-prompt-fill-fields" onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); insert(); } }}>
        {prompt && <Suspense fallback={formFallback}><PromptForm key={prompt.id} names={names} onChange={setValues} autoFocus /></Suspense>}
        {prompt && <section className="handwork-prompt-fill-preview" aria-label="Prompt to insert">
          <span>Prompt to insert</span>
          <p>{promptParts(prompt.text).map((part, index) => part.kind === 'text' ? <span key={index}>{part.text}</span>
            : values[part.name]?.trim() ? <mark key={index} className="handwork-prompt-filled">{values[part.name].trim()}</mark>
            : <span key={index} className="handwork-prompt-variable">{humanizeVariable(part.name)}</span>)}</p>
        </section>}
      </DialogBody>
      <DialogFooter>
        <span className="handwork-settings-note handwork-prompt-fill-count">{filled} of {names.length} filled</span>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="button" onClick={insert}><CornerDownLeft aria-hidden width={14} height={14} />Insert</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
