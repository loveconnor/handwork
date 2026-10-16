"use client";
import { useState } from 'react';
import { ChevronDown, Folder, FolderOpen, LoaderCircle, Plus, Ellipsis, Pencil, Pin, X, Trash2 } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from '@/components/ui/menu';

type Chat = { id: string; label: string; workspace?: string; updatedAt?: string; pinned?: boolean };
export function HandworkSidebarContent({ projects, sessions, activeSession, runningSession, runningSessions, unreadSessions, busy, connecting, disabled, chatDisabled, onAdd, onNewProjectChat, onChat, openSessions, onRename, onPin, onClose, onDelete }: {
  projects: string[]; sessions: Chat[]; activeSession: string; runningSession: string; runningSessions?: Set<string>; unreadSessions: Set<string>; busy: boolean; connecting: boolean; disabled: boolean; chatDisabled: boolean;
  onAdd: () => void; onChat: (chat: Chat) => void;
  onNewProjectChat: (project: string) => void;
  openSessions: string[]; onRename: (chat: Chat) => void; onPin: (chat: Chat) => void; onClose: (id: string) => void; onDelete: (chat: Chat) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (setter: typeof setCollapsed, key: string) => setter(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const chatRow = (chat: Chat, group: string) => {
    const active = activeSession === chat.id && (group === 'recents' ? !chat.workspace : chat.workspace === group);
    return <div key={`${group}-${chat.id}`} className={`handwork-chat-item ${active ? 'is-active' : ''}`}>
    <Button className="handwork-chat-row" variant="ghost" size="sm" disabled={chatDisabled} title={chat.label} aria-description={chat.pinned ? "Pinned chat" : undefined} aria-current={active ? 'page' : undefined} onClick={() => onChat(chat)}>
      <span>{chat.label}</span>{chat.pinned && <Pin aria-hidden width={12} height={12} />}{(runningSessions ? runningSessions.has(chat.id) : busy && runningSession === chat.id) ? <span className="handwork-chat-running" role="status" aria-label="Working"><LoaderCircle aria-hidden width={14} height={14} className="motion-safe:animate-spin" /></span> : unreadSessions.has(chat.id) && activeSession !== chat.id ? <span className="handwork-chat-unread" role="status" aria-label="Unread response" /> : null}
    </Button>
    <Menu>
      <MenuTrigger render={<Button className="handwork-chat-menu-trigger" variant="ghost" size="icon-sm" aria-label={`Options for ${chat.label}`} title="Chat options" disabled={disabled} />}><Ellipsis aria-hidden width={16} height={16} /></MenuTrigger>
      <MenuPopup align="start" side="right" sideOffset={6} className="handwork-chat-menu" aria-label={`Options for ${chat.label}`}>
        <MenuItem onClick={() => onRename(chat)}><Pencil aria-hidden />Rename</MenuItem>
        <MenuItem onClick={() => onPin(chat)}><Pin aria-hidden />{chat.pinned ? 'Unpin' : 'Pin'}</MenuItem>
        {openSessions.includes(chat.id) && <MenuItem onClick={() => onClose(chat.id)}><X aria-hidden />Close tab</MenuItem>}
        <MenuSeparator />
        <MenuItem variant="destructive" disabled={runningSessions?.has(chat.id)} onClick={() => onDelete(chat)}><Trash2 aria-hidden />Delete</MenuItem>
      </MenuPopup>
    </Menu>
  </div>;
  };
  return <div className="handwork-sidebar-groups">
    <span className="sr-only" role="status" aria-label={connecting ? 'Connecting to Handwork' : busy ? 'Working' : activeSession ? 'Native Handwork' : 'Not connected'}>{connecting ? 'Connecting to Handwork' : busy ? 'Working' : activeSession ? 'Native Handwork' : 'Not connected'}</span>
    <div className="handwork-sidebar-section-heading"><span>Projects</span><Button variant="ghost" size="icon-sm" aria-label="Add project" disabled={disabled} onClick={onAdd}><Plus aria-hidden width={15} height={15} /></Button></div>
    {projects.map(project => {
      const chats = sessions.filter(chat => chat.workspace === project);
      const open = !collapsed.has(project);
      const shown = expanded.has(project) ? chats : chats.slice(0, 5);
      return <section key={project} aria-label={project.split('/').filter(Boolean).pop() || project}>
        <div className="handwork-project-heading">
          <Button variant="ghost" size="sm" className="handwork-project-name" title={project} aria-expanded={open} onClick={() => toggle(setCollapsed, project)}>{open ? <FolderOpen aria-hidden width={16} height={16} /> : <Folder aria-hidden width={16} height={16} />}<span>{project.split('/').filter(Boolean).pop() || project}</span></Button>
          <Button variant="ghost" size="icon-sm" aria-label={`New chat in ${project.split('/').filter(Boolean).pop() || project}`} title="New chat in project" disabled={disabled} onClick={() => onNewProjectChat(project)}><Plus aria-hidden width={16} height={16} /></Button>
        </div>
        {open && <div className="handwork-project-chats">{shown.map(chat => chatRow(chat, project))}
          {!chats.length && <span className="handwork-sidebar-empty">No chats yet</span>}
          {chats.length > 5 && <Button className="handwork-show-more" variant="ghost" size="sm" onClick={() => toggle(setExpanded, project)}>{expanded.has(project) ? 'Show fewer' : 'Show more'}</Button>}
        </div>}
      </section>;
    })}
    <section aria-label="Recents">
      <Button variant="ghost" size="sm" className="handwork-recents-heading" aria-expanded={!collapsed.has('recents')} onClick={() => toggle(setCollapsed, 'recents')}>Recents<ChevronDown aria-hidden width={13} height={13} /></Button>
      {!collapsed.has('recents') && <div className="handwork-recent-chats">{sessions.slice(0, expanded.has('recents') ? undefined : 10).map(chat => chatRow(chat, 'recents'))}
        {sessions.length > 10 && <Button variant="ghost" size="sm" className="handwork-show-more" onClick={() => toggle(setExpanded, 'recents')}>{expanded.has('recents') ? 'Show fewer' : 'Show more'}</Button>}
      </div>}
    </section>
  </div>;
}
