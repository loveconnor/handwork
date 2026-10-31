"use client";

import { useEffect, useMemo, useState } from 'react';
import { Search } from 'honestui/icons';
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription, DialogBody } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { DesktopPreferences } from '@/lib/desktop-api';
import { isMac, matchScore, shortcutKeys } from '@/lib/saved-prompts';
import { shortcutGroups } from '@/lib/shortcuts';

function Keys({ keys }: { keys: string }) {
  return <span className="handwork-shortcut-keys">{shortcutKeys(keys).map((key, index) => <kbd key={index}>{key}</kbd>)}</span>;
}

/** A read-only reference of every keyboard shortcut, grouped by where it works. */
export function HandworkShortcuts({ open, onOpenChange, preferences, desktop }: {
  open: boolean; onOpenChange: (open: boolean) => void; preferences?: DesktopPreferences; desktop: boolean;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => { if (!open) setQuery(''); }, [open]);
  const groups = useMemo(() => shortcutGroups({ sendKey: preferences?.sendKey, quickEntryShortcut: preferences?.quickEntryShortcut, desktop, mac: isMac })
    .map(group => ({ ...group, items: group.items.filter(item => matchScore(`${group.title} ${item.label} ${item.detail ?? ''}`, query.trim())) }))
    .filter(group => group.items.length), [preferences?.sendKey, preferences?.quickEntryShortcut, desktop, query]);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogPopup className="handwork-shortcuts" initialFocus={() => document.getElementById('handwork-shortcut-filter')}>
      <DialogHeader><DialogTitle>Keyboard shortcuts</DialogTitle><DialogDescription>Open this list any time with <kbd>{shortcutKeys('Mod').join('')}</kbd><kbd>/</kbd> or from the command palette.</DialogDescription></DialogHeader>
      <DialogBody>
        <div className="handwork-shortcut-filter">
          <Search aria-hidden width={14} height={14} />
          <Input id="handwork-shortcut-filter" type="search" aria-label="Filter shortcuts" placeholder="Filter shortcuts…" value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        {groups.length ? <div className="handwork-shortcut-groups">{groups.map(group => <section key={group.title} aria-labelledby={`handwork-shortcuts-${group.title}`}>
          <h3 id={`handwork-shortcuts-${group.title}`}>{group.title}</h3>
          <dl>{group.items.map(item => <div key={item.label} className="handwork-shortcut-row">
            <dt>{item.label}{item.detail && <span>{item.detail}</span>}</dt>
            <dd>{item.keys.map((keys, index) => <span key={keys} className="handwork-shortcut-choice">{index > 0 && <span className="handwork-shortcut-or">or</span>}<Keys keys={keys} /></span>)}</dd>
          </div>)}</dl>
        </section>)}</div> : <p role="status" className="handwork-settings-note">No shortcuts match “{query.trim()}”.</p>}
      </DialogBody>
    </DialogPopup>
  </Dialog>;
}
