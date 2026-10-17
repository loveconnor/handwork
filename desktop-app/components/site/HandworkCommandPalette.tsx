"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, MessageSquare, FolderOpen, BookText, ChevronRight, Check, TextSearch, ChevronLeft, Archive, Star } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { Command, CommandContent, CommandDialog, CommandDialogContent, CommandEmpty, CommandGroup, CommandItem, CommandInput, CommandLabel } from '@/components/ui/command';
import { ProviderLogo } from '@/components/site/ProviderLogo';
import type { ChatSearchResult, DesktopAPI, SavedPrompt } from '@/lib/desktop-api';
import type { ConfigOption } from '@/lib/desktop-state';
import { matchScore, promptSlug, shortcutLabel } from '@/lib/saved-prompts';
import { modelDisplayName, settingDisplayName } from '@/lib/model-presentation';
import type { ModelShortcut } from '@/lib/model-shortcuts';

type Chat = { id: string; label: string; workspace?: string; updatedAt?: string; archived?: boolean };
export type PaletteAction = { id: string; label: string; description?: string; icon: ReactNode; keywords?: string; shortcut?: string; disabled?: boolean; group?: 'actions' | 'view' | 'commands'; run: () => void };
export type PaletteChoicePage = { id: string; label: string; icon: ReactNode; option: ConfigOption; disabled?: boolean };
type Entry = { id: string; group: string; label: string; detail?: string; icon: ReactNode; hint?: ReactNode; disabled?: boolean; search: string; run: () => void; snippet?: string };

const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(`(${terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return <>{text.split(pattern).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part)}</>;
}

function choiceName(option: ConfigOption, name: string) {
  return option.id === 'model' ? modelDisplayName(name) : option.id === 'provider' ? name : settingDisplayName(name);
}

/** ⌘K: run commands, switch settings, and search chat titles and message text. */
export function HandworkCommandPalette({ open, initialPage = '', onOpenChange, api, chats, projects, prompts, actions, pages, models, onOpenChat, onNewProjectChat, onUsePrompt, onChoose, onChooseModel }: {
  open: boolean; initialPage?: string; onOpenChange: (open: boolean) => void; api?: DesktopAPI;
  chats: Chat[]; projects: string[]; prompts: SavedPrompt[]; actions: PaletteAction[]; pages: PaletteChoicePage[];
  /** Favorite and frequently used models, offered without opening the model list. */
  models?: { favorites: ModelShortcut[]; frequent: ModelShortcut[] };
  onOpenChat: (chat: Chat, find?: string) => void; onNewProjectChat: (project: string) => void;
  onUsePrompt: (prompt: SavedPrompt) => void; onChoose: (optionId: string, value: string) => void;
  onChooseModel?: (model: ModelShortcut) => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(initialPage);
  const [messages, setMessages] = useState<{ query: string; terms: string[]; results: ChatSearchResult[]; status: 'idle' | 'loading' | 'ready' | 'failed' }>({ query: '', terms: [], results: [], status: 'idle' });
  const requestId = useRef(0);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!event.repeat && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [open, onOpenChange]);
  useEffect(() => { if (!open) { setQuery(''); setPage(''); setMessages({ query: '', terms: [], results: [], status: 'idle' }); } else if (initialPage) { setQuery(''); setPage(initialPage); } }, [open, initialPage]);

  // Message text is searched in the main process after a short pause in typing.
  const trimmed = query.trim();
  useEffect(() => {
    if (!open || page || !api?.searchChats || trimmed.length < 2) { requestId.current++; setMessages(current => current.status === 'idle' ? current : { query: '', terms: [], results: [], status: 'idle' }); return; }
    const id = ++requestId.current;
    setMessages(current => ({ ...current, status: 'loading' }));
    const timer = setTimeout(() => {
      api.searchChats(trimmed).then(result => {
        if (id === requestId.current) setMessages({ query: trimmed, terms: result.terms, results: result.results, status: 'ready' });
      }).catch(() => { if (id === requestId.current) setMessages({ query: trimmed, terms: [], results: [], status: 'failed' }); });
    }, 160);
    return () => clearTimeout(timer);
  }, [open, page, api, trimmed]);

  const close = () => onOpenChange(false);
  const activePage = pages.find(item => item.id === page);
  const commandPage = page === 'commands';
  const archivedPage = page === 'archived';
  const subpage = !!activePage || commandPage || archivedPage;
  const pageLabel = activePage?.label || (archivedPage ? 'Archived chats' : 'Slash commands');
  const chatById = useMemo(() => new Map(chats.map(chat => [chat.id, chat])), [chats]);

  const entries = useMemo<Entry[]>(() => {
    const chatEntry = (chat: Chat, group: string): Entry => ({ id: `chat:${chat.id}`, group, label: chat.label, detail: [chat.archived && group !== 'Archived chats' ? 'Archived' : '', chat.workspace ? projectName(chat.workspace) : ''].filter(Boolean).join(' · ') || undefined, icon: chat.archived ? <Archive aria-hidden /> : <MessageSquare aria-hidden />, search: `${chat.label} ${chat.workspace ? projectName(chat.workspace) : ''}${chat.archived ? ' archived' : ''}`, run: () => { close(); onOpenChat(chat); } });
    if (archivedPage) return chats.filter(chat => chat.archived).map(chat => chatEntry(chat, 'Archived chats'));
    if (activePage) {
      const option = activePage.option;
      // Favorite models lead the model list and carry a star.
      const provider = pages.find(item => item.id === 'provider')?.option.currentValue ?? '';
      const favorites = new Set(option.id === 'model' ? (models?.favorites ?? []).filter(item => item.provider === provider).map(item => item.model) : []);
      const choices = favorites.size ? [...option.options].sort((a, b) => Number(favorites.has(b.value)) - Number(favorites.has(a.value))) : option.options;
      return choices.map(choice => ({
        id: `choice:${choice.value}`, group: activePage.label, label: choiceName(option, choice.name), detail: choice.description, search: `${choice.name} ${choice.value} ${choice.description ?? ''}`,
        icon: option.id === 'provider' ? <ProviderLogo provider={choice.value} size={16} /> : <span className="handwork-palette-check">{choice.value === option.currentValue && <Check aria-hidden />}</span>,
        hint: option.id === 'provider' && choice.value === option.currentValue ? <Check aria-hidden /> : favorites.has(choice.value) ? <Star aria-label="Favorite" className="handwork-favorite-star" /> : undefined,
        disabled: activePage.disabled,
        run: () => { if (choice.value !== option.currentValue) onChoose(option.id, choice.value); close(); },
      }));
    }
    const list: Entry[] = [];
    for (const action of actions) {
      if (commandPage ? action.group !== 'commands' : action.group === 'commands' && !trimmed) continue;
      list.push({ id: `action:${action.id}`, group: action.group === 'commands' ? 'Commands' : action.group === 'view' ? 'View' : 'Actions', label: action.label, detail: action.description, icon: action.icon, disabled: action.disabled, search: `${action.label} ${action.description ?? ''} ${action.keywords ?? ''}`, hint: action.shortcut ? <kbd>{shortcutLabel(action.shortcut)}</kbd> : undefined, run: () => { close(); action.run(); } });
    }
    if (commandPage) return list;
    for (const item of pages) {
      const current = item.option.options.find(choice => choice.value === item.option.currentValue);
      list.push({ id: `page:${item.id}`, group: 'Settings', label: item.label, icon: item.icon, disabled: item.disabled, search: `${item.label} ${item.option.name} switch change`, hint: <><span className="handwork-palette-value">{current ? choiceName(item.option, current.name) : ''}</span><ChevronRight aria-hidden /></>, run: () => { setPage(item.id); setQuery(''); } });
    }
    const modelPage = pages.find(item => item.id === 'model');
    const providerNames = new Map((pages.find(item => item.id === 'provider')?.option.options ?? []).map(choice => [choice.value, choice.name]));
    for (const [model, favorite] of [...(models?.favorites ?? []).map(item => [item, true] as const), ...(models?.frequent ?? []).map(item => [item, false] as const)]) {
      const provider = providerNames.get(model.provider) ?? model.provider;
      list.push({ id: `model:${model.key}`, group: 'Models', label: `Use ${modelDisplayName(model.name)}`, detail: favorite ? `Favorite · ${provider}` : `Frequently used · ${provider}`, icon: <ProviderLogo provider={model.provider} size={16} />,
        hint: model.current ? <Check aria-label="Current model" /> : favorite ? <Star aria-label="Favorite" className="handwork-favorite-star" /> : undefined,
        disabled: modelPage?.disabled || !onChooseModel, search: `${model.name} ${model.model} ${provider} model switch use ${favorite ? 'favorite' : 'recent frequent'}`, run: () => { close(); if (!model.current) onChooseModel?.(model); } });
    }
    // Archived chats stay searchable, but only recent chats show before typing.
    for (const chat of chats) if (trimmed || !chat.archived) list.push(chatEntry(chat, 'Chats'));
    for (const prompt of prompts) list.push({ id: `prompt:${prompt.id}`, group: 'Saved prompts', label: prompt.title, detail: `/${promptSlug(prompt)}`, icon: <BookText aria-hidden />, search: `${prompt.title} ${prompt.folder} ${promptSlug(prompt)} ${prompt.text.slice(0, 400)}`, run: () => { close(); onUsePrompt(prompt); } });
    for (const project of projects) list.push({ id: `project:${project}`, group: 'Projects', label: `New chat in ${projectName(project)}`, detail: project, icon: <FolderOpen aria-hidden />, search: `${projectName(project)} project open ${project}`, run: () => { close(); onNewProjectChat(project); } });
    return list;
    // `close` only depends on onOpenChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage, commandPage, archivedPage, trimmed, actions, pages, models, chats, prompts, projects, onChoose, onChooseModel, onOpenChat, onNewProjectChat, onUsePrompt, onOpenChange]);

  const groups = useMemo(() => {
    const limits: Record<string, number> = archivedPage ? {} : trimmed ? { Chats: 6, Models: 5, 'Saved prompts': 5, Projects: 4 } : { Chats: 6, Models: 5, 'Saved prompts': 4, Projects: 3 };
    const ranked = entries.map(entry => ({ entry, score: matchScore(entry.search, trimmed) })).filter(item => item.score > 0);
    if (trimmed && !activePage && !archivedPage) ranked.sort((a, b) => b.score - a.score);
    const map = new Map<string, Entry[]>();
    for (const { entry } of ranked) {
      const items = map.get(entry.group) ?? [];
      if (items.length < (limits[entry.group] ?? 50)) items.push(entry);
      map.set(entry.group, items);
    }
    if (!subpage && trimmed.length >= 2) {
      const results = messages.query === trimmed ? messages.results.filter(result => chatById.has(result.sessionId)) : [];
      if (results.length) map.set('Messages', results.slice(0, 8).map(result => {
        const chat = chatById.get(result.sessionId)!;
        return { id: `message:${result.sessionId}`, group: 'Messages', label: chat.label, snippet: result.snippet, detail: `${result.matches} matching message${result.matches === 1 ? '' : 's'}`, icon: <TextSearch aria-hidden />, search: '', run: () => { close(); onOpenChat(chat, messages.terms.join(' ')); } };
      }));
    }
    // With a query, the strongest group leads; without one, actions lead.
    const order = trimmed && !activePage ? [...map.keys()] : ['Actions', 'Commands', 'Models', 'Chats', 'Saved prompts', 'Projects', 'Settings', 'View', ...[...map.keys()]];
    return [...new Set(order)].filter(key => map.has(key)).map(key => ({ label: key, items: map.get(key)! }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, trimmed, activePage, archivedPage, subpage, messages, chatById]);
  const ids = groups.flatMap(group => group.items.map(item => item.id));
  const searching = !subpage && trimmed.length >= 2 && messages.status === 'loading';

  return <CommandDialog open={open} onOpenChange={onOpenChange}>
    <CommandDialogContent title="Command palette" className="handwork-chat-search handwork-palette" finalFocus={() => document.querySelector<HTMLElement>('[data-slot="prompt-bar-input"]')}>
      <Command key={`${open}-${page}`} items={ids} mode="none" value={query} onValueChange={value => setQuery(value)}>
        <div className="handwork-search-heading">
          {subpage && <Button variant="ghost" size="sm" className="handwork-palette-crumb" aria-label="Back to all commands" onClick={() => { setPage(''); setQuery(''); }}><ChevronLeft aria-hidden width={14} height={14} />{pageLabel}</Button>}
          <CommandInput aria-label={subpage ? pageLabel : 'Search commands, chats, and messages'} placeholder={commandPage ? 'Filter slash commands…' : archivedPage ? 'Filter archived chats…' : activePage ? 'Filter options…' : 'Search commands, chats, and messages…'} leadingIcon={subpage ? undefined : <Search />}
            onKeyDown={event => { if (subpage && event.key === 'Backspace' && !query) { event.preventDefault(); setPage(''); } }} />
          <Button variant="ghost" size="sm" aria-label="Close command palette" onClick={close}>Esc</Button>
        </div>
        <CommandContent aria-label="Results">
          {!ids.length && <CommandEmpty>{searching ? 'Searching messages…' : trimmed ? `No results for “${trimmed}”.` : archivedPage ? 'No archived chats. Archive a chat from its menu in the sidebar.' : 'Nothing to show yet.'}</CommandEmpty>}
          {groups.map(group => <CommandGroup key={group.label}>
            <CommandLabel>{group.label}{group.label === 'Messages' && searching && <span className="handwork-palette-searching" role="status"> · Updating…</span>}</CommandLabel>
            {group.items.map(entry => <CommandItem key={entry.id} value={entry.id} disabled={entry.disabled} leadingIcon={entry.icon} trailingIcon={entry.hint} onClick={entry.run} className={entry.snippet ? 'handwork-palette-message' : undefined}>
              <span className="handwork-search-title"><Highlighted text={entry.label} terms={group.label === 'Messages' ? messages.terms : []} /></span>
              {entry.snippet ? <span className="handwork-palette-snippet"><Highlighted text={entry.snippet} terms={messages.terms} /></span> : entry.detail && <span className="handwork-search-project">{entry.detail}</span>}
            </CommandItem>)}
          </CommandGroup>)}
          {!subpage && trimmed.length >= 2 && messages.status === 'ready' && messages.query === trimmed && !messages.results.length && ids.length > 0 && <p className="handwork-palette-note">No messages contain “{trimmed}”.</p>}
          {!subpage && messages.status === 'failed' && <p className="handwork-palette-note" role="alert">Message search is unavailable right now. Chat titles are still searched.</p>}
        </CommandContent>
        <div className="handwork-search-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> {activePage ? 'choose' : 'open'}</span>{subpage ? <span><kbd>⌫</kbd> back</span> : <span>Use “quotes” for exact phrases</span>}</div>
      </Command>
    </CommandDialogContent>
  </CommandDialog>;
}
