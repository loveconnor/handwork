"use client";
import { HoverTooltip } from "@/components/ui/tooltip";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Archive, ArchiveRestore, ChevronDown, CornerDownRight, LoaderCircle, Plus, Ellipsis, Pencil, Pin, X, Trash2 } from 'honestui/icons';
import { Button } from '@/components/ui/button';
import { AttentionIcon } from './HandworkAttention';
import type { AttentionKind } from '@/lib/attention';
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from '@/components/ui/menu';
import { orderSidebarChats, readSidebarKeys, sidebarChatTime, visibleSidebarChats } from '@/lib/sidebar-chats';

function storedKeys(key: string) {
  try { return readSidebarKeys(localStorage.getItem(key)); } catch { return []; }
}

type Chat = { id: string; label: string; workspace?: string; updatedAt?: string; pinned?: boolean; archived?: boolean };
const projectName = (project: string) => project.split(/[\\/]/).filter(Boolean).pop() || project;

function CollapsibleChats({ open, children }: { open: boolean; children: ReactNode }) {
  return <div className="handwork-sidebar-collapse" data-open={open} aria-hidden={!open} inert={!open}>
    <div className="handwork-sidebar-collapse-content">{children}</div>
  </div>;
}

export function HandworkSidebarContent({ attention, projects, sessions, activeSession, runningSession, runningSessions, unreadSessions, queuedSessions, busy, connecting, disabled, chatDisabled, onAdd, onNewProjectChat, onDeleteProject, onChat, openSessions, onRename, onPin, onArchive, onClose, onDelete, onDismissIssue }: {
  attention?: Map<string, AttentionKind>; projects: string[]; sessions: Chat[]; activeSession: string; runningSession: string; runningSessions?: Set<string>; unreadSessions: Set<string>; queuedSessions?: Map<string, number>; busy: boolean; connecting: boolean; disabled: boolean; chatDisabled: boolean;
  onAdd: () => void; onChat: (chat: Chat) => void;
  onNewProjectChat: (project: string) => void;
  onDeleteProject: (project: string) => void;
  onDismissIssue: (id: string) => void;
  openSessions: string[]; onRename: (chat: Chat) => void; onPin: (chat: Chat) => void; onArchive: (chat: Chat, archived: boolean) => void; onClose: (id: string) => void; onDelete: (chat: Chat) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(storedKeys('handwork-sidebar-collapsed-v1')));
  const order = useRef(storedKeys('handwork-sidebar-order-v1'));
  const ordered = orderSidebarChats(sessions, order.current);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    order.current = ordered.map(chat => chat.id);
    try { localStorage.setItem('handwork-sidebar-order-v1', JSON.stringify(order.current)); } catch { /* Storage is optional. */ }
  }, [sessions]);
  useEffect(() => {
    try { localStorage.setItem('handwork-sidebar-collapsed-v1', JSON.stringify([...collapsed])); } catch { /* Storage is optional. */ }
  }, [collapsed]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Archived chats leave Chats and Projects but stay one click away, and in search.
  const [archivedOpen, setArchivedOpen] = useState(false);
  const recentsOpen = !collapsed.has('recents');
  const active = ordered.filter(chat => !chat.archived);
  const archived = ordered.filter(chat => chat.archived);
  const normalChats = active.filter(chat => !chat.workspace);
  const emptyLabel = (archivedCount: number, fallback: string) => archivedCount ? 'All chats here are archived' : fallback;
  const toggle = (setter: typeof setCollapsed, key: string) => setter(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const shownChats = (chats: Chat[], group: string) => visibleSidebarChats(chats, expanded.has(group), activeSession, attention, runningSessions);
  const groupSignal = (chats: Chat[]) => {
    const waiting = chats.filter(chat => { const kind = attention?.get(chat.id); return kind && kind !== 'running'; }).length;
    const working = chats.filter(chat => runningSessions?.has(chat.id)).length;
    const unread = chats.filter(chat => unreadSessions.has(chat.id)).length;
    if (!waiting && !working && !unread) return null;
    const label = waiting ? `${waiting} need${waiting === 1 ? 's' : ''} you` : working ? `${working} working` : `${unread} unread`;
    return <span className="handwork-group-signal" data-needs={!!waiting || undefined} aria-label={label} title={label}>{waiting || working || unread}<span className="handwork-group-mark" data-kind={waiting ? 'needs' : working ? 'working' : 'unread'} aria-hidden>{waiting ? '!' : null}</span></span>;
  };
  const chatRow = (chat: Chat, group: string) => {
    const current = activeSession === chat.id && (group === 'recents' ? !chat.workspace : group === 'archived' || chat.workspace === group);
    const running = runningSessions ? runningSessions.has(chat.id) : busy && runningSession === chat.id;
    const queued = queuedSessions?.get(chat.id) ?? 0;
    // Approvals, failures, and paused replies each look different from plain activity.
    const needs = attention?.get(chat.id);
    const flagged = needs && needs !== 'running' ? needs : undefined;
    const flagLabel = flagged === 'approval' ? 'Needs you: waiting for approval' : flagged === 'failed' ? 'Reply failed' : flagged === 'queue' ? 'Queue paused' : 'Reply paused';
    const unread = unreadSessions.has(chat.id) && !current;
    const status = flagged ? flagLabel : running ? 'Working' : unread ? 'New response' : 'Read';
    return <div key={`${group}-${chat.id}`} className={`handwork-chat-item ${current ? 'is-active' : ''}`} data-needs={flagged === 'approval' || undefined} data-unread={unread || undefined}>
    <Button className="handwork-chat-row" variant="ghost" size="sm" disabled={chatDisabled} title={group === 'archived' && chat.workspace ? `${chat.label} · ${projectName(chat.workspace)}` : chat.label} aria-description={chat.archived ? "Archived chat" : chat.pinned ? "Pinned chat" : undefined} aria-current={current ? 'page' : undefined} onClick={() => onChat(chat)}>
      {flagged || running || unread ? <HoverTooltip content={status}><span className="handwork-chat-status" data-kind={flagged || (running ? 'running' : 'unread')} role="img" aria-label={status}>{flagged ? <AttentionIcon kind={flagged} size={14} /> : running ? <LoaderCircle aria-hidden width={14} height={14} className="motion-safe:animate-spin" /> : <span className="handwork-chat-unread" aria-hidden />}</span></HoverTooltip> : <span className="handwork-chat-status" aria-hidden />}
      <span className="handwork-chat-label">{chat.label}</span>
      {chat.pinned && !chat.archived && <Pin className="handwork-chat-pin" aria-label="Pinned" width={11} height={11} />}
      {queued > 0 && <span className="handwork-chat-queued" aria-label={`${queued} queued messages`}><CornerDownRight aria-hidden />{queued}</span>}
      <span className="handwork-chat-time" data-status={flagged || running || undefined} title={chat.updatedAt ? new Date(chat.updatedAt).toLocaleString() : undefined}>{flagged === 'approval' ? 'Needs you' : running ? 'Working' : sidebarChatTime(chat.updatedAt, now)}</span>
    </Button>
    <Menu>
      <MenuTrigger render={<Button className="handwork-chat-menu-trigger" variant="ghost" size="icon-sm" aria-label={`Options for ${chat.label}`} title="Chat options" disabled={disabled} />}><Ellipsis aria-hidden width={16} height={16} /></MenuTrigger>
      <MenuPopup align="start" side="right" sideOffset={6} className="handwork-chat-menu" aria-label={`Options for ${chat.label}`}>
        <MenuItem onClick={() => onRename(chat)}><Pencil aria-hidden />Rename</MenuItem>
        {!chat.archived && <MenuItem onClick={() => onPin(chat)}><Pin aria-hidden />{chat.pinned ? 'Unpin' : 'Pin'}</MenuItem>}
        {chat.archived ? <MenuItem onClick={() => onArchive(chat, false)}><ArchiveRestore aria-hidden />Restore</MenuItem>
          : <MenuItem disabled={running} onClick={() => onArchive(chat, true)}><Archive aria-hidden />Archive</MenuItem>}
        {openSessions.includes(chat.id) && <MenuItem onClick={() => onClose(chat.id)}><X aria-hidden />Close tab</MenuItem>}
        {(flagged === 'failed' || flagged === 'interrupted') && <MenuItem onClick={() => onDismissIssue(chat.id)}><X aria-hidden />Dismiss status</MenuItem>}
        <MenuSeparator />
        <MenuItem variant="destructive" disabled={running} onClick={() => onDelete(chat)}><Trash2 aria-hidden />Delete</MenuItem>
      </MenuPopup>
    </Menu>
  </div>;
  };
  return <div className="handwork-sidebar-groups">
    <span className="sr-only" role="status" aria-label={connecting ? 'Connecting to Handwork' : busy ? 'Working' : activeSession ? 'Native Handwork' : 'Not connected'}>{connecting ? 'Connecting to Handwork' : busy ? 'Working' : activeSession ? 'Native Handwork' : 'Not connected'}</span>
    {(normalChats.length > 0 || projects.length === 0) && <section aria-label="General chats">
      <Button variant="ghost" size="sm" className="handwork-recents-heading" aria-expanded={recentsOpen} onClick={() => toggle(setCollapsed, 'recents')}><ChevronDown className="handwork-section-chevron" aria-hidden width={12} height={12} /><span>General</span>{groupSignal(normalChats)}</Button>
      <CollapsibleChats open={recentsOpen}><div className="handwork-recent-chats">{shownChats(normalChats, 'recents').map(chat => chatRow(chat, 'recents'))}
        {!normalChats.length && <span className="handwork-sidebar-empty">{emptyLabel(archived.filter(chat => !chat.workspace).length, 'No chats outside projects yet')}</span>}
        {(shownChats(normalChats, 'recents').length < normalChats.length || expanded.has('recents') && normalChats.length > 5) && <Button variant="ghost" size="sm" className="handwork-show-more" onClick={() => toggle(setExpanded, 'recents')}>{expanded.has('recents') ? 'Show fewer' : 'Show more'}</Button>}
      </div></CollapsibleChats>
    </section>}
    <div className="handwork-sidebar-section-heading"><span>Projects</span><Button variant="ghost" size="icon-sm" aria-label="Add project" disabled={disabled} onClick={onAdd}><Plus aria-hidden width={15} height={15} /></Button></div>
    {projects.map(project => {
      const chats = active.filter(chat => chat.workspace === project);
      const open = !collapsed.has(project);
      const shown = shownChats(chats, project);
      return <section key={project} aria-label={projectName(project)}>
        <div className="handwork-project-heading">
          <Button variant="ghost" size="sm" className="handwork-project-name" title={project} aria-expanded={open} onClick={() => toggle(setCollapsed, project)}><ChevronDown className="handwork-section-chevron" aria-hidden width={12} height={12} /><span>{projectName(project)}</span>{groupSignal(chats)}</Button>
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
          {(shown.length < chats.length || expanded.has(project) && chats.length > 5) && <Button className="handwork-show-more" variant="ghost" size="sm" onClick={() => toggle(setExpanded, project)}>{expanded.has(project) ? 'Show fewer' : 'Show more'}</Button>}
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
