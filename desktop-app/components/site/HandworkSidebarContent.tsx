"use client";
import { HoverTooltip } from "@/components/ui/tooltip";
import { useState, type ReactNode } from 'react';
import { Archive, ArchiveRestore, ChevronDown, CornerDownRight, Folder, FolderOpen, LoaderCircle, Plus, Ellipsis, Pencil, Pin, X, Trash2 } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { AttentionIcon } from './HandworkAttention';
import type { AttentionKind } from '@/lib/attention';
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from '@/components/ui/menu';

type Chat = { id: string; label: string; workspace?: string; updatedAt?: string; pinned?: boolean; archived?: boolean };
const projectName = (project: string) => project.split('/').filter(Boolean).pop() || project;

function CollapsibleChats({ open, children }: { open: boolean; children: ReactNode }) {
  return <div className="handwork-sidebar-collapse" data-open={open} aria-hidden={!open} inert={!open}>
    <div className="handwork-sidebar-collapse-content">{children}</div>
  </div>;
}

export function HandworkSidebarContent({ attention, projects, sessions, activeSession, runningSession, runningSessions, unreadSessions, queuedSessions, busy, connecting, disabled, chatDisabled, onAdd, onNewProjectChat, onDeleteProject, onChat, openSessions, onRename, onPin, onArchive, onClose, onDelete }: {
  attention?: Map<string, AttentionKind>; projects: string[]; sessions: Chat[]; activeSession: string; runningSession: string; runningSessions?: Set<string>; unreadSessions: Set<string>; queuedSessions?: Map<string, number>; busy: boolean; connecting: boolean; disabled: boolean; chatDisabled: boolean;
  onAdd: () => void; onChat: (chat: Chat) => void;
  onNewProjectChat: (project: string) => void;
  onDeleteProject: (project: string) => void;
  openSessions: string[]; onRename: (chat: Chat) => void; onPin: (chat: Chat) => void; onArchive: (chat: Chat, archived: boolean) => void; onClose: (id: string) => void; onDelete: (chat: Chat) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Archived chats leave Chats and Projects but stay one click away, and in search.
  const [archivedOpen, setArchivedOpen] = useState(false);
  const recentsOpen = !collapsed.has('recents');
  const active = sessions.filter(chat => !chat.archived);
  const archived = sessions.filter(chat => chat.archived);
  const normalChats = active.filter(chat => !chat.workspace);
  const emptyLabel = (archivedCount: number, fallback: string) => archivedCount ? 'All chats here are archived' : fallback;
  const toggle = (setter: typeof setCollapsed, key: string) => setter(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const chatRow = (chat: Chat, group: string) => {
    const current = activeSession === chat.id && (group === 'recents' ? !chat.workspace : group === 'archived' || chat.workspace === group);
    const running = runningSessions ? runningSessions.has(chat.id) : busy && runningSession === chat.id;
    const queued = queuedSessions?.get(chat.id) ?? 0;
    // Approvals, failures, and paused replies each look different from plain activity.
    const needs = attention?.get(chat.id);
    const flagged = needs === 'approval' || needs === 'failed' || needs === 'interrupted' ? needs : undefined;
    const flagLabel = flagged === 'approval' ? 'Waiting for your approval' : flagged === 'failed' ? 'Reply failed' : 'Reply paused';
    return <div key={`${group}-${chat.id}`} className={`handwork-chat-item ${current ? 'is-active' : ''}`}>
    <Button className="handwork-chat-row" variant="ghost" size="sm" disabled={chatDisabled} title={group === 'archived' && chat.workspace ? `${chat.label} · ${projectName(chat.workspace)}` : chat.label} aria-description={chat.archived ? "Archived chat" : chat.pinned ? "Pinned chat" : undefined} aria-current={current ? 'page' : undefined} onClick={() => onChat(chat)}>
      <span>{chat.label}</span>{chat.pinned && !chat.archived && <Pin aria-hidden width={12} height={12} />}{queued > 0 && <HoverTooltip content={`${queued} queued message${queued === 1 ? '' : 's'}`}><span className="handwork-chat-queued" role="status" aria-label={`${queued} queued message${queued === 1 ? '' : 's'}`} ><CornerDownRight aria-hidden />{queued}</span></HoverTooltip>}{flagged ? <HoverTooltip content={flagLabel}><span className="handwork-chat-flag" data-kind={flagged} role="status" aria-label={flagLabel} ><AttentionIcon kind={flagged} size={13} /></span></HoverTooltip> : running ? <span className="handwork-chat-running" role="status" aria-label="Working"><LoaderCircle aria-hidden width={14} height={14} className="motion-safe:animate-spin" /></span> : unreadSessions.has(chat.id) && activeSession !== chat.id ? <span className="handwork-chat-unread" role="status" aria-label="Unread response" /> : null}
    </Button>
    <Menu>
      <MenuTrigger render={<Button className="handwork-chat-menu-trigger" variant="ghost" size="icon-sm" aria-label={`Options for ${chat.label}`} title="Chat options" disabled={disabled} />}><Ellipsis aria-hidden width={16} height={16} /></MenuTrigger>
      <MenuPopup align="start" side="right" sideOffset={6} className="handwork-chat-menu" aria-label={`Options for ${chat.label}`}>
        <MenuItem onClick={() => onRename(chat)}><Pencil aria-hidden />Rename</MenuItem>
        {!chat.archived && <MenuItem onClick={() => onPin(chat)}><Pin aria-hidden />{chat.pinned ? 'Unpin' : 'Pin'}</MenuItem>}
        {chat.archived ? <MenuItem onClick={() => onArchive(chat, false)}><ArchiveRestore aria-hidden />Restore</MenuItem>
          : <MenuItem disabled={running} onClick={() => onArchive(chat, true)}><Archive aria-hidden />Archive</MenuItem>}
        {openSessions.includes(chat.id) && <MenuItem onClick={() => onClose(chat.id)}><X aria-hidden />Close tab</MenuItem>}
        <MenuSeparator />
        <MenuItem variant="destructive" disabled={runningSessions?.has(chat.id)} onClick={() => onDelete(chat)}><Trash2 aria-hidden />Delete</MenuItem>
      </MenuPopup>
    </Menu>
  </div>;
  };
  return <div className="handwork-sidebar-groups">
    <span className="sr-only" role="status" aria-label={connecting ? 'Connecting to Handwork' : busy ? 'Working' : activeSession ? 'Native Handwork' : 'Not connected'}>{connecting ? 'Connecting to Handwork' : busy ? 'Working' : activeSession ? 'Native Handwork' : 'Not connected'}</span>
    <section aria-label="Chats">
      <Button variant="ghost" size="sm" className="handwork-recents-heading" aria-expanded={recentsOpen} onClick={() => toggle(setCollapsed, 'recents')}>Chats<ChevronDown className="handwork-section-chevron" aria-hidden width={13} height={13} /></Button>
      <CollapsibleChats open={recentsOpen}><div className="handwork-recent-chats">{normalChats.slice(0, expanded.has('recents') ? undefined : 5).map(chat => chatRow(chat, 'recents'))}
        {!normalChats.length && <span className="handwork-sidebar-empty">{emptyLabel(archived.filter(chat => !chat.workspace).length, 'No chats outside projects yet')}</span>}
        {normalChats.length > 5 && <Button variant="ghost" size="sm" className="handwork-show-more" onClick={() => toggle(setExpanded, 'recents')}>{expanded.has('recents') ? 'Show fewer' : 'Show more'}</Button>}
      </div></CollapsibleChats>
    </section>
    <div className="handwork-sidebar-section-heading"><span>Projects</span><Button variant="ghost" size="icon-sm" aria-label="Add project" disabled={disabled} onClick={onAdd}><Plus aria-hidden width={15} height={15} /></Button></div>
    {projects.map(project => {
      const chats = active.filter(chat => chat.workspace === project);
      const open = !collapsed.has(project);
      const shown = expanded.has(project) ? chats : chats.slice(0, 5);
      return <section key={project} aria-label={projectName(project)}>
        <div className="handwork-project-heading">
          <Button variant="ghost" size="sm" className="handwork-project-name" title={project} aria-expanded={open} onClick={() => toggle(setCollapsed, project)}>{open ? <FolderOpen aria-hidden width={16} height={16} /> : <Folder aria-hidden width={16} height={16} />}<span>{projectName(project)}</span></Button>
          <Menu>
            <MenuTrigger render={<Button className="handwork-project-menu-trigger" variant="ghost" size="icon-sm" aria-label={`Options for project ${projectName(project)}`} title="Project options" disabled={disabled} />}><Ellipsis aria-hidden width={16} height={16} /></MenuTrigger>
            <MenuPopup align="start" side="right" sideOffset={6} className="handwork-chat-menu" aria-label="Project options">
              <MenuItem variant="destructive" onClick={() => onDeleteProject(project)}><Trash2 aria-hidden />Delete project</MenuItem>
            </MenuPopup>
          </Menu>
          <Button variant="ghost" size="icon-sm" aria-label={`New chat in ${projectName(project)}`} title="New chat in project" disabled={disabled} onClick={() => onNewProjectChat(project)}><Plus aria-hidden width={16} height={16} /></Button>
        </div>
        <CollapsibleChats open={open}><div className="handwork-project-chats">{shown.map(chat => chatRow(chat, project))}
          {!chats.length && <span className="handwork-sidebar-empty">{emptyLabel(archived.filter(chat => chat.workspace === project).length, 'No chats yet')}</span>}
          {chats.length > 5 && <Button className="handwork-show-more" variant="ghost" size="sm" onClick={() => toggle(setExpanded, project)}>{expanded.has(project) ? 'Show fewer' : 'Show more'}</Button>}
        </div></CollapsibleChats>
      </section>;
    })}
    {archived.length > 0 && <section aria-label="Archived chats" className="handwork-archived-section">
      <Button variant="ghost" size="sm" className="handwork-recents-heading" aria-expanded={archivedOpen} onClick={() => setArchivedOpen(value => !value)}>
        <span className="handwork-archived-heading"><Archive aria-hidden width={13} height={13} />Archived<span className="handwork-archived-count">{archived.length}</span></span>
        <ChevronDown className="handwork-section-chevron" aria-hidden width={13} height={13} />
      </Button>
      <CollapsibleChats open={archivedOpen}><div className="handwork-recent-chats">{archived.slice(0, expanded.has('archived') ? undefined : 5).map(chat => chatRow(chat, 'archived'))}
        {archived.length > 5 && <Button variant="ghost" size="sm" className="handwork-show-more" onClick={() => toggle(setExpanded, 'archived')}>{expanded.has('archived') ? 'Show fewer' : 'Show more'}</Button>}
      </div></CollapsibleChats>
    </section>}
  </div>;
}
