"use client";

import { useEffect } from 'react';
import { Search, MessageSquare } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { Command, CommandContent, CommandDialog, CommandDialogContent, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandLabel } from '@/components/ui/command';

type Chat = { id: string; label: string; workspace?: string };

export function HandworkChatSearch({ open, onOpenChange, chats, onSelect }: {
  open: boolean; onOpenChange: (open: boolean) => void; chats: Chat[]; onSelect: (chat: Chat) => void;
}) {
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!event.repeat && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [open, onOpenChange]);

  return <CommandDialog open={open} onOpenChange={onOpenChange}>
    <CommandDialogContent title="Search chats" className="handwork-chat-search" finalFocus={() => {
      const trigger = document.querySelector<HTMLElement>('[data-slot="button"][aria-label="Search chats"]');
      return trigger?.getClientRects().length ? trigger : document.querySelector<HTMLElement>('[data-slot="prompt-bar-input"]');
    }}>
      <Command key={open ? 'open' : 'closed'}>
        <div className="handwork-search-heading">
          <CommandInput aria-label="Search chats" placeholder="Search chats by title…" leadingIcon={<Search />} />
          <Button variant="ghost" size="sm" aria-label="Close search" onClick={() => onOpenChange(false)}>Esc</Button>
        </div>
        <CommandContent aria-label="Chats">
          <CommandEmpty>{chats.length ? 'No matching chats.' : 'No chats yet.'}</CommandEmpty>
          {chats.length > 0 && <CommandGroup>
            <CommandLabel>Recent chats</CommandLabel>
            {chats.map(chat => <CommandItem key={chat.id} value={`${chat.label} ${chat.workspace || ''} ${chat.id}`} leadingIcon={<MessageSquare />} onClick={() => { onOpenChange(false); onSelect(chat); }}>
              <span className="handwork-search-title">{chat.label}</span>
              {chat.workspace && <span className="handwork-search-project">{chat.workspace.split('/').filter(Boolean).pop()}</span>}
            </CommandItem>)}
          </CommandGroup>}
        </CommandContent>
        <div className="handwork-search-footer"><span>↑ ↓ to navigate</span><span>↵ to open</span></div>
      </Command>
    </CommandDialogContent>
  </CommandDialog>;
}
