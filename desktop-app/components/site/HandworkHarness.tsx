"use client";

import { HoverTooltip } from "@/components/ui/tooltip";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { HandworkWindowControls } from './HandworkWindowControls';
import HandworkChanges, { ChangesTrigger } from '@/components/site/HandworkChanges';
import { useProjectChanges } from '@/lib/use-project-changes';
import { SidebarNav } from "@/components/ui/sidebar-nav";
import { PromptBar } from "@/components/ui/prompt-bar";
import { LoadingState } from "honestui/ai/loading-state";
import { HandworkConversation } from "@/components/site/HandworkConversation";
import { ApprovalCard } from "honestui/ai/approval-card";
import HandworkTranscript, { type MessageVersion } from "@/components/site/HandworkTranscript";
import { Button } from "@/components/ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { IconFileText, IconSettings, IconMic, IconPlus, IconClose } from "@/components/atoms/Icons";
import { ComposerOptions, HandworkTheme, chooseTheme } from "@/components/site/HandworkControls";
import type { SettingsSnapshot, Attachment, DesktopAPI, SessionResult, ProjectSuggestion, ChatPreference, SavedPrompt, ModelPreferences, RestoreResult, SavedDraft } from "@/lib/desktop-api";
import { useLocalDictation } from '@/lib/use-local-dictation';
import { applyUpdate, availableCommands, configOptions, emptyConversation, withSavedUsage, permissionFromEvent, providerList, record, text, type Command, type ConfigOption, type Conversation, type Entry, type Permission, type ProviderInfo } from "@/lib/desktop-state";
import { chatTitle, isPlaceholderTitle } from '@/electron/chat-title.mjs';
import { mergeSidebarChats, sortChatsByRecency } from '@/lib/chat-order';
import { chatVersionIds, collapseChatVersions, versionPosition, versionTurns } from '@/lib/chat-versions';
import { modelShortcuts, type ModelShortcut } from '@/lib/model-shortcuts';
import { desktopSlashCommands, parseSlashCommand, resolveSlashCommand } from '@/lib/slash-commands.mjs';
import { HandworkSidebarContent } from "@/components/site/HandworkSidebarContent";
import { HandworkCommandPalette, type PaletteAction, type PaletteChoicePage } from "@/components/site/HandworkCommandPalette";
import { HandworkFindBar } from "@/components/site/HandworkFindBar";
import { HandworkPromptLibrary, PromptFillDialog } from "@/components/site/HandworkPromptLibrary";
import { HandworkFileViewer, type FileTarget } from "@/components/site/HandworkFileViewer";
import { HandworkQueue, type QueuedMessage } from "@/components/site/HandworkQueue";
import { mergeQueues, queueCounts, queueKey, readyQueues, restoreQueues, type Queues } from "@/lib/message-queue";
import { planAttachments, stageAttachments, type RejectedFile } from "@/lib/attachment-staging";
import { attentionItems, nextAttention, type AttentionItem, type AttentionKind, type ChatIssue } from "@/lib/attention";
import { adjacentTab, numberedTab, rememberClosed, reopenCandidate } from "@/lib/tab-navigation";
import { draftKey, splitDrafts } from '@/lib/draft-recovery';
import { queueConfiguration, type ConfigChange } from '@/lib/configuration-queue';
import { HandworkSubscriptionUsage } from '@/components/site/HandworkSubscriptionUsage';
import { HandworkAttachmentTray } from "@/components/site/HandworkAttachmentTray";
import { HandworkChatDetails } from "@/components/site/HandworkChatDetails";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator, MenuShortcut } from "@/components/ui/menu";
import { Search, RefreshCw, RotateCcw, SquarePen, FolderPlus, TextSearch, BookText, Bookmark, SquareDashedMousePointer, Paperclip, Settings as SettingsIcon, Download, Activity, GitCompare, Pencil, Cpu, Plug, Gauge, Shield, SunMoon, Archive, ArchiveRestore, Keyboard, History, Star, Info, Hand } from "honestui/icons";
import { isMac, promptSlug, promptVariables, shortcutLabel } from "@/lib/saved-prompts";
import { applyAppearance } from "@/lib/appearance";
import { modelDisplayName } from "@/lib/model-presentation";
import SettingsModal from "@/components/site/SettingsModal";
import { ResizeHandle, useStoredSize } from "@/components/site/HandworkResizeHandle";
import HandworkActivity from "@/components/site/HandworkActivity";
import HandworkUpdate from "@/components/site/HandworkUpdate";
import HandworkCommandReport, { type ReportCommand } from '@/components/site/HandworkCommandReport';
import { HandworkShortcuts } from '@/components/site/HandworkShortcuts';

const tabActions = ['new', 'next', 'previous', 'reopen', 'close', 'attention', 'details', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
type TabAction = typeof tabActions[number];
const isTabAction = (value: string): value is TabAction => (tabActions as readonly string[]).includes(value);

type SavedSession = { id: string; label: string; workspace?: string; updatedAt?: string; turns?: number; pinned?: boolean; archived?: boolean };

const cleanError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function readConversation(snapshot: { title: string; updates: unknown[] }, fallbackTitle: string): Conversation {
  return snapshot.updates.reduce<Conversation>((current, update) => applyUpdate(current, record(update)), { ...emptyConversation(), title: snapshot.title || fallbackTitle });
}

const sidebarCacheKey = 'handwork-sidebar-v1';
function cachedSidebar(): { projects: string[]; sessions: SavedSession[] } {
  try {
    const value = JSON.parse(localStorage.getItem(sidebarCacheKey) || 'null');
    if (Array.isArray(value?.projects) && value.projects.every((item: unknown) => typeof item === 'string') && Array.isArray(value.sessions) && value.sessions.every((item: SavedSession) => item && typeof item.id === 'string' && typeof item.label === 'string')) return value;
  } catch { /* An unavailable or stale cache never blocks startup. */ }
  return { projects: [], sessions: [] };
}

/** Honest AI application frame backed by the native Handwork ACP engine. */
export default function HandworkHarness() {
  const [initialSidebar] = useState(cachedSidebar);
  const [api, setApi] = useState<DesktopAPI>();
  const [preferences, setPreferences] = useState<SettingsSnapshot>();
  const [startupReady, setStartupReady] = useState(false);
  const startupChat = useRef<SavedSession | undefined>(undefined);
  const initialHistoryRefresh = useRef(true);
  function receivePreferences(value: SettingsSnapshot) { setPreferences(value); applyAppearance(value.app); }
  const [workspace, setWorkspace] = useState("");
  const [suggestionState, setSuggestionState] = useState<{ key: string; items: ProjectSuggestion[]; status: "loading" | "ready" | "failed" }>({ key: "", items: [], status: "ready" });
  const [suggestionRetry, setSuggestionRetry] = useState(0);
  const [projects, setProjects] = useState<string[]>(initialSidebar.projects);
  const [autoConnect, setAutoConnect] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [conversation, setConversation] = useState<Conversation>(emptyConversation);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [palettePage, setPalettePage] = useState('');
  const [reportCommand, setReportCommand] = useState<ReportCommand>();
  const [settingsSection, setSettingsSection] = useState<'models'>();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [modelPreferences, setModelPreferences] = useState<ModelPreferences>();
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [library, setLibrary] = useState<{ open: boolean; draft?: string }>({ open: false });
  const [fillingPrompt, setFillingPrompt] = useState<SavedPrompt>();
  const [find, setFind] = useState({ open: false, query: "", focus: 0 });
  const [capturing, setCapturing] = useState(false);
  const [quickPrompt, setQuickPrompt] = useState<{ text: string; attachments: Attachment[] }>();
  const [viewingFile, setViewingFile] = useState<FileTarget>();
  // An action shown beside a notice, valid only while that notice is visible.
  const [noticeAction, setNoticeAction] = useState<{ notice: string; label: string; run: () => void }>();
  const [failedPrompt, setFailedPrompt] = useState<{ session: string; text: string; files: Attachment[]; error: string }>();
  const [queues, setQueues] = useState<Queues>({});
  const [pausedQueues, setPausedQueues] = useState<Set<string>>(new Set());
  // Queues saved before a restart, until the person resumes or changes them.
  const [restoredQueues, setRestoredQueues] = useState<Set<string>>(new Set());
  const queuesRef = useRef<Queues>({});
  queuesRef.current = queues;
  const savedQueues = useRef(new Map<string, string>());
  const queuesLoaded = useRef(false);
  const restoredQueueCount = useRef(0);
  const [chatRequest, setChatRequest] = useState<string>();
  // Tab and chat actions from the app menu, handled with the current state.
  const [tabRequest, setTabRequest] = useState<{ action: TabAction; at: number }>();
  const lastTabAction = useRef<{ action: string; at: number }>({ action: '', at: 0 });
  const savedDrafts = useRef(new Map<string, string>());
  const pendingDraft = useRef<{ id: string; text: string; files: Attachment[] | null; key: string }>(undefined);
  const [recoveredDrafts, setRecoveredDrafts] = useState<SavedDraft[]>([]);
  const [recoveringDraft, setRecoveringDraft] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState<{ session: string; key: string }>();
  // Actions stored with a notice run against the newest chat state, not the state when they were created.
  const latest = useRef<{ retryLast: () => Promise<void>; openVersion: (id: string) => void }>({ retryLast: async () => {}, openVersion: () => {} });
  const activeWorkspace = useRef("");
  const [sessions, setSessions] = useState<SavedSession[]>(initialSidebar.sessions);
  const [tabs, setTabs] = useState<SavedSession[]>([]);
  const [options, setOptions] = useState<ConfigOption[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [chatPreferences, setChatPreferences] = useState<Record<string, ChatPreference>>({});
  const [chatAction, setChatAction] = useState<{ kind: "rename" | "delete"; chat: SavedSession }>();
  const [projectToDelete, setProjectToDelete] = useState<string>();
  const [deletingProject, setDeletingProject] = useState(false);
  const [projectDeleteError, setProjectDeleteError] = useState("");
  const [chatName, setChatName] = useState("");
  const [savingChat, setSavingChat] = useState(false);
  const [chatActionError, setChatActionError] = useState("");
  const [runningSessions, setRunningSessions] = useState<Set<string>>(new Set());
  const running = useRef(new Set<string>());
  const busy = runningSessions.has(sessionId);
  const drafts = useRef(new Map<string, { text: string; files: Attachment[] }>());
  const permissionCache = useRef(new Map<string, Permission[]>());
  const [unreadSessions, setUnreadSessions] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [picking, setPicking] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Files read asynchronously are checked against what is attached when they arrive.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // Files that could not be added to the composer, each with its reason.
  const [rejectedFiles, setRejectedFiles] = useState<RejectedFile[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Failed and interrupted replies per chat, until the chat sends again or the person dismisses them.
  const [chatIssues, setChatIssues] = useState<Record<string, ChatIssue>>({});
  // Background approvals and recovery live in refs; this re-renders the attention view when they change.
  const [, setBackgroundVersion] = useState(0);
  const [attentionFocus, setAttentionFocus] = useState<{ id: string; kind: AttentionKind }>();
  const closedTabs = useRef<SavedSession[]>([]);
  const [narrowSidebar, setNarrowSidebar] = useState(false);
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersReady, setProvidersReady] = useState(false);
  const [busyProvider, setBusyProvider] = useState("");
  const [providerError, setProviderError] = useState("");
  const [activityOpen, setActivityOpen] = useState(true);
  const [activityRequested, setActivityRequested] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const reviewPanel = useRef<HTMLElement>(null);
  const [reviewWidth, setReviewWidth] = useStoredSize('handwork.reviewPanelWidth');
  useEffect(() => { if (changesOpen) reviewPanel.current?.focus(); }, [changesOpen]);
  const activeSession = useRef("");
  const lock = useRef(false);
  const operation = useRef(0);
  const chatCache = useRef(new Map<string, Conversation>());
  const historyReplay = useRef<{ id: string; conversation: Conversation } | undefined>(undefined);
  const [historyPreview, setHistoryPreview] = useState<{ id: string; conversation: Conversation }>();
  const [pendingChat, setPendingChat] = useState<SavedSession>();
  const pendingChatRef = useRef<SavedSession | undefined>(undefined);
  const [navigating, setNavigating] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const dictation = useLocalDictation({ api, composerKey: `${pendingChat?.id ?? sessionId}:${workspace}:${working}:${navigating}`, onText: text => setDraft(current => current.trim() ? `${current.trimEnd()} ${text}` : text), onError: setError });
  const configPending = useRef(false);
  const configVersion = useRef(0);
  const configTail = useRef<Promise<boolean>>(Promise.resolve(true));
  const confirmedOptions = useRef<ConfigOption[]>([]);
  const providerOptions = useRef(new Map<string, ConfigOption[]>());

  useEffect(() => {
    const media = window.matchMedia("(max-width: 700px)");
    const update = () => setNarrowSidebar(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  function rememberOptions(next: ConfigOption[]) {
    confirmedOptions.current = next;
    const provider = next.find(option => option.id === 'provider')?.currentValue;
    if (provider) providerOptions.current.set(provider, next);
  }

  useEffect(() => {
    if (!sessionId || working) return;
    chatCache.current.delete(sessionId);
    chatCache.current.set(sessionId, conversation);
    if (chatCache.current.size > 20) {
      const evict = [...chatCache.current.keys()].find(id => id !== sessionId && !running.current.has(id));
      if (evict) chatCache.current.delete(evict);
    }
  }, [conversation, sessionId, working]);

  function markChatRead(id: string) {
    setUnreadSessions(current => {
      if (!current.has(id)) return current;
      const next = new Set(current); next.delete(id); return next;
    });
  }

  function openChat(chat: SavedSession) {
    if (!api || picking) return;
    markChatRead(chat.id);
    if (chat.id === sessionId && !working && !navigating) {
      pendingChatRef.current = undefined;
      setPendingChat(undefined);
      return;
    }
    pendingChatRef.current = chat;
    setPendingChat(chat);
    setError(""); setNotice("");
    if (!chatCache.current.has(chat.id) && api.readSession) {
      void api.readSession(chat.id).then(result => {
        const snapshot = readConversation(result, chat.label);
        // A live response owns its in-memory transcript. Disk history may lag it.
        if (running.current.has(chat.id) || chatCache.current.has(chat.id) || pendingChatRef.current?.id !== chat.id) return;
        chatCache.current.set(chat.id, snapshot);
        if (pendingChatRef.current?.id === chat.id) {
          setHistoryPreview({ id: chat.id, conversation: snapshot });
          if (activeSession.current === chat.id) setConversation(snapshot);
        }
      }).catch(() => { /* The authoritative load reports missing or unreadable history. */ });
    }
  }

  useEffect(() => {
    if (!pendingChat || !api || working || configuring || navigating || picking || lock.current) return;
    const requested = pendingChat;
    setNavigating(true);
    void (async () => {
      if ((requested.workspace ?? '') !== activeWorkspace.current) {
        const selected = requested.workspace ? await api.selectProject(requested.workspace) : await api.selectChat();
        activeWorkspace.current = selected.path;
        setWorkspace(selected.path);
      }
      if (pendingChatRef.current === requested) await sessionAction("load", requested.id);
    })().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => {
      if (pendingChatRef.current === requested) {
        pendingChatRef.current = undefined;
        setPendingChat(undefined);
      }
      setNavigating(false);
    });
    // Session operations are serialized; the newest selection stays visible while they finish.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingChat, api, working, configuring, navigating, busy, picking]);

  useEffect(() => {
    const bridge = window.handwork;
    setApi(bridge);
    if (!bridge) return;
    bridge.listPrompts?.().then(setPrompts).catch(cause => setNotice(cause instanceof Error ? cause.message : String(cause)));
    // Model shortcuts are optional; without them the picker lists every model as before.
    bridge.getModelPreferences?.().then(setModelPreferences).catch(() => {});
    let mounted = true;
    void Promise.all([bridge.listProjects(), bridge.getSettings?.(), bridge.getStartup?.(), bridge.getUpdateDrafts?.().catch(() => { setNotice('Saved update drafts could not be restored.'); return []; }), bridge.listDrafts?.().catch(() => []), bridge.listQueues?.().catch(() => { setNotice('Queued messages from your last session could not be restored.'); return []; })]).then(async ([paths, saved, startup, updateDrafts, savedDraftList, savedQueueList]) => {
      if (!mounted) return;
      const restoredQueue = restoreQueues(savedQueueList ?? []);
      savedQueues.current = restoredQueue.keys;
      restoredQueueCount.current = restoredQueue.count;
      queuesLoaded.current = true;
      if (restoredQueue.count) { setQueues(restoredQueue.queues); setPausedQueues(restoredQueue.paused); setRestoredQueues(new Set(restoredQueue.paused)); }
      // Keep every original until it has been moved durably to an open chat.
      const known = new Set([...(startup?.tabs ?? []).map(tab => tab.id), ...initialSidebar.sessions.map(session => session.id)]);
      for (const entry of savedDraftList ?? []) {
        savedDrafts.current.set(entry.id, draftKey(entry.text, entry.files));
        drafts.current.set(entry.id, { text: entry.text, files: entry.files });
      }
      setRecoveredDrafts(splitDrafts(savedDraftList ?? [], known).orphans);
      for (const entry of updateDrafts ?? []) drafts.current.set(entry.id, { text: entry.text, files: entry.files });
      setProjects(paths);
      if (saved) {
        if (!saved.initialized) {
          const legacy = localStorage.getItem('bui-theme');
          if (legacy === 'light' || legacy === 'dark') saved = await bridge.updateSettings('app', { theme: legacy });
        }
        if (!mounted) return;
        receivePreferences(saved);
      }
      const restored = saved?.app.restoreChats && startup ? startup.tabs.filter(tab => tab.workspace === '' || paths.includes(tab.workspace)) : [];
      const active = startup?.active ? restored.find(tab => tab.id === startup.active) || restored[0] : undefined;
      if (restored.length) setTabs(restored);
      startupChat.current = active;
      const selected = active?.workspace ?? '';
      activeWorkspace.current = selected;
      setWorkspace(selected);
      setAutoConnect(selected);
    }).catch(cause => { if (mounted) setError(String(cause)); });
    const unsubscribe = bridge.onEvent(event => {
      const params = record(event.params);
      if (event.method === 'desktop/settings') { receivePreferences(event.params as SettingsSnapshot); return; }
      if (event.method === 'desktop/suggestions-cleared') { setSuggestionState({ key: '', items: [], status: 'ready' }); setSuggestionRetry(value => value + 1); return; }
      if (event.method === 'desktop/open-settings') { setSettingsOpen(true); return; }
      if (event.method === 'desktop/open-shortcuts') { setShortcutsOpen(true); return; }
      if (event.method === 'desktop/models') { setModelPreferences(event.params as ModelPreferences); return; }
      if (event.method === 'desktop/open-chat') { setChatRequest(text(params.sessionId)); return; }
      if (event.method === 'desktop/chat-usage') { const id = text(params.sessionId); if (id) setChatPreferences(current => ({ ...current, [id]: { ...current[id], usage: params.usage as ChatPreference['usage'] } })); return; }
      if (event.method === 'desktop/tab') { const action = text(params.action); if (isTabAction(action)) setTabRequest({ action, at: Date.now() }); return; }
      if (event.method === 'desktop/quick-prompt') { setQuickPrompt({ text: text(params.text), attachments: Array.isArray(params.attachments) ? params.attachments as Attachment[] : [] }); return; }
      if (event.method === "desktop/notice") { setNotice(text(params.message)); return; }
      if (event.method === "window/state") { setFullscreen(params.fullscreen === true); setMaximized(params.maximized === true); return; }
      if (event.method === "engine/error") {
        const failedSession = text(params.sessionId);
        if (failedSession && failedSession !== activeSession.current) {
          permissionCache.current.delete(failedSession);
          setUnreadSessions(current => new Set(current).add(failedSession));
          return;
        }
        setError(text(params.message) || "The Handwork engine stopped. Reopen the project to reconnect.");
        setPermissions([]);
        setSessionId("");
        activeSession.current = "";
        return;
      }
      const eventSession = text(params.sessionId);
      if (eventSession && eventSession !== activeSession.current) {
        if (event.method === 'session/update') {
          chatCache.current.set(eventSession, applyUpdate(chatCache.current.get(eventSession) ?? emptyConversation(), record(params.update)));
          // Recovery state decides whether a background chat needs attention.
          if (record(params.update).sessionUpdate === 'session_info_update') setBackgroundVersion(value => value + 1);
        } else if (event.method === 'session/request_permission') {
          const permission = permissionFromEvent(record(event));
          if (permission) permissionCache.current.set(eventSession, [...(permissionCache.current.get(eventSession) ?? []).filter(p => p.id !== permission.id), permission]);
          setUnreadSessions(current => new Set(current).add(eventSession));
          setBackgroundVersion(value => value + 1);
        } else if (event.method === 'engine/permissions_cleared') { permissionCache.current.delete(eventSession); setBackgroundVersion(value => value + 1); }
        return;
      }
      if (event.method === "session/update") {
        const update = record(params.update);
        if (historyReplay.current?.id === eventSession) {
          historyReplay.current.conversation = applyUpdate(historyReplay.current.conversation, update);
        } else setConversation(current => applyUpdate(current, update));
        if (update.sessionUpdate === "config_option_update" && !configPending.current) {
          const next = configOptions(update.configOptions);
          rememberOptions(next); setOptions(next);
        }
        if (update.sessionUpdate === "available_commands_update") setCommands(availableCommands(update.availableCommands));
      } else if (event.method === "session/request_permission") {
        const permission = permissionFromEvent(record(event));
        if (permission) setPermissions(current => [...current.filter(p => p.id !== permission.id), permission]);
      } else if (event.method === "engine/permissions_cleared") {
        setPermissions([]);
      }
    });
    const settingsError = (event: Event) => setError((event as CustomEvent<string>).detail);
    window.addEventListener('handwork:settings-error', settingsError);
    return () => { mounted = false; unsubscribe(); window.removeEventListener('handwork:settings-error', settingsError); };
  }, []);

  const titlePrompt = conversation.entries.find(entry => entry.kind === 'user')?.text || '';
  useEffect(() => {
    if (!sessionId) return;
    setTabs(current => current.map(tab => tab.id === sessionId ? { ...tab, label: chatTitle(conversation.title, titlePrompt) } : tab));
  }, [conversation.title, titlePrompt, sessionId]);
  useEffect(() => {
    if (!api || autoConnect === undefined) return;
    setAutoConnect(undefined);
    void (async () => {
      const restore = startupChat.current; startupChat.current = undefined;
      if (restore) {
        const selected = autoConnect ? await api.selectProject(autoConnect) : await api.selectChat();
        activeWorkspace.current = selected.path;
        setWorkspace(selected.path);
        if (!pendingChatRef.current) openChat(restore);
      } else await sessionAction('chat');
    })().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setStartupReady(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, autoConnect]);

  useEffect(() => {
    if (!api?.saveStartup || !startupReady || working || navigating || !sessionId) return;
    const timeout = setTimeout(() => {
      // Empty native sessions are discarded on shutdown and cannot be restored.
      const savedTabs = tabs.filter(tab => (chatCache.current.get(tab.id)?.entries.length || sessions.some(session => session.id === tab.id && session.turns !== 0)) && tab.workspace !== undefined && (tab.workspace === '' || projects.includes(tab.workspace))).slice(-30).map(tab => ({ id: tab.id, label: tab.label, workspace: tab.workspace! }));
      void api.saveStartup({ tabs: savedTabs, active: savedTabs.some(tab => tab.id === sessionId) ? sessionId : '' }).catch(cause => setError(String(cause)));
    }, 250);
    return () => clearTimeout(timeout);
  }, [api, startupReady, tabs, projects, sessionId, working, navigating, conversation.entries.length, sessions]);

  async function refreshSessions(bridge: DesktopAPI) {
    const workspace = activeWorkspace.current;
    const result = record(await bridge.listSessions());
    if (activeWorkspace.current !== workspace) return;
    setChatPreferences(record(result.preferences) as Record<string, ChatPreference>);
    if (Array.isArray(result.sessions)) setSessions(result.sessions.map(item => {
      const session = record(item);
      const updatedAt = text(session.updatedAt);
      const turns = typeof session.turns === "number" ? session.turns : undefined;
      return { workspace: typeof session.cwd === 'string' ? session.cwd : workspace, id: text(session.sessionId), label: chatTitle(text(session.title)), updatedAt, turns, pinned: session.pinned === true, archived: session.archived === true };
    // Sessions that never received a message stay out of the list unless they are open in a tab.
    }).filter(session => session.id && session.turns !== 0));
  }
  useEffect(() => {
    if (!startupReady) return;
    try { localStorage.setItem(sidebarCacheKey, JSON.stringify({ projects, sessions })); } catch { /* Storage is optional. */ }
  }, [startupReady, projects, sessions]);

  async function refreshProviders(bridge: DesktopAPI) {
    try { setProviders(providerList(await bridge.listProviders())); setProvidersReady(true); setProviderError(""); }
    catch (cause) { setProvidersReady(false); setProviderError(cause instanceof Error ? cause.message : String(cause)); }
  }
  useEffect(() => {
    if (api && settingsOpen) void refreshProviders(api);
  }, [api, settingsOpen]);
  /** Switch the active provider (used for keyless providers such as a local Ollama). */
  async function useProvider(id: string) {
    if (provider) await configure(provider.id, id);
  }
  /** Connect, sign in, or disconnect a provider, then refresh what the picker may offer. */
  async function providerAction(kind: "connect" | "signIn" | "disconnect", id: string, apiKey = "") {
    if (!api) return;
    setBusyProvider(id); setProviderError("");
    try {
      const result = kind === "connect" ? await api.connectProvider(id, apiKey) : kind === "disconnect" ? await api.disconnectProvider(id) : (await api.signInProvider(id), await api.listProviders());
      setProviders(providerList(result));
      setProvidersReady(true);
      if (!activeSession.current && kind !== "disconnect") await sessionAction("chat");
    } catch (cause) { setProviderError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusyProvider(""); }
  }
  function acceptSession(result: SessionResult, created = false) {
    activeSession.current = result.sessionId;
    setSessionId(result.sessionId);
    const next = configOptions(result.configOptions);
    setCommands(availableCommands(result.availableCommands));
    rememberOptions(next); setOptions(next);
    setTabs(current => current.some(tab => tab.id === result.sessionId) ? current : [...current, { id: result.sessionId, label: "New chat", workspace: activeWorkspace.current, updatedAt: created ? new Date().toISOString() : undefined }]);
  }
  async function sessionAction(action: "open" | "connect" | "new" | "load" | "chat" | "project", id?: string) {
    if (configPending.current) await configTail.current;
    if (!api || lock.current) return;
    dictation.cancel();
    lock.current = true;
    setError(""); setNotice("");
    drafts.current.set(activeSession.current, { text: draft, files: attachments });
    if (activeSession.current) {
      chatCache.current.set(activeSession.current, conversation);
      permissionCache.current.set(activeSession.current, permissions);
    }
    try {
      if (action === "open") {
        setPicking(true);
        const selected = await api.chooseWorkspace();
        setPicking(false);
        if (!selected) return;
        activeWorkspace.current = selected.path;
        setWorkspace(selected.path);
        setProjects(await api.listProjects());
      }
      if (action === "connect" || action === "project") {
        const selected = id || workspace ? await api.selectProject(id || workspace) : await api.selectChat();
        activeWorkspace.current = selected.path;
        setWorkspace(selected.path);
      }
      if (action === 'chat') { activeWorkspace.current = ''; setWorkspace(''); }
      setWorking(true);
      // session/load streams its history before the response arrives.
      activeSession.current = action === "load" ? id! : "";
      setSessionId("");
      const cached = action === 'load' && id ? chatCache.current.get(id) : undefined;
      const initial = cached ?? { ...emptyConversation(), title: action === "load" ? sessions.find(session => session.id === id)?.label ?? tabs.find(tab => tab.id === id)?.label ?? "Chat" : "New chat" };
      setConversation(initial);
      if (action === 'load' && !running.current.has(id!)) historyReplay.current = { id: id!, conversation: { ...emptyConversation(), title: initial.title } };
      setPermissions(action === 'load' ? permissionCache.current.get(id!) ?? [] : []);
      const savedDraft = action === 'load' ? drafts.current.get(id!) : undefined;
      setDraft(savedDraft?.text ?? ''); setAttachments(savedDraft?.files ?? []); setRejectedFiles([]);
      const result = action === "load" ? await api.loadSession(id!) : action === "chat" ? await api.newChat() : action === "new" || action === "project" ? await api.newSession() : await api.connect();
      if (action === 'load') {
        const replay = historyReplay.current;
        if (replay && result.historyReplayed !== false) {
          chatCache.current.set(id!, replay.conversation);
          setConversation(replay.conversation);
        } else {
          const retained = chatCache.current.get(id!) ?? readConversation(await api.readSession(id!), initial.title);
          chatCache.current.set(id!, retained);
          setConversation(retained);
        }
      }
      acceptSession(result, action !== 'load');
      if (api.getSettings) void api.getSettings().then(receivePreferences).catch(() => {});
      if (action !== "load" || initialHistoryRefresh.current) {
        initialHistoryRefresh.current = false;
        void refreshSessions(api).catch(() => {});
      }
      if (!providersReady) void refreshProviders(api);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!activeSession.current && /needs a .*subscription login/.test(message)) {
        setError("Connect a provider in Settings to start chatting.");
        setSettingsOpen(true);
      } else setError(message);
    }
    finally { historyReplay.current = undefined; lock.current = false; setWorking(false); setPicking(false); }
  }
  async function prepareUpdateRestart() {
    const snapshot = new Map(drafts.current);
    snapshot.set(activeSession.current, { text: draft, files: attachments });
    if (api) await api.saveStartup({ tabs: tabs.map(tab => ({ id: tab.id, label: tab.label, workspace: tab.workspace ?? '' })), active: tabs.some(tab => tab.id === activeSession.current) ? activeSession.current : '' });
    return [...snapshot].filter(([, value]) => value.text || value.files.length).map(([id, value]) => ({ id, ...value }));
  }
  /** Adds files that fit; every file that does not is listed with its reason. */
  function stageFiles(incoming: Attachment[], rejected: RejectedFile[] = []) {
    const staged = stageAttachments(attachmentsRef.current, incoming);
    attachmentsRef.current = staged.files;
    setAttachments(staged.files);
    setRejectedFiles([...rejected, ...staged.rejected]);
  }
  /** Dropped files retain their bytes; the backend prepares native file targets. */
  async function stageDroppedFiles(files: File[]) {
    setError("");
    // Sizes and the file limit are checked before anything is read.
    const plan = planAttachments(attachmentsRef.current, files.map(file => ({ name: file.name, size: file.size })));
    const staged: Attachment[] = [];
    const unreadable: RejectedFile[] = [];
    for (const index of plan.accepted) {
      const file = files[index];
      try {
        const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
        staged.push({ name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, data: url.slice(url.indexOf(",") + 1) });
      } catch { unreadable.push({ name: file.name, reason: "Could not be read" }); }
    }
    stageFiles(staged, [...plan.rejected, ...unreadable]);
  }
  async function addFiles() {
    if (!api) return;
    try {
      const picked = await api.chooseFiles(Math.max(0, 10 - attachmentsRef.current.length));
      // Older desktop builds return only the files.
      if (Array.isArray(picked)) stageFiles(picked);
      else if (picked.files.length || picked.rejected.length) stageFiles(picked.files, picked.rejected);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function touchChat(id: string) {
    const updatedAt = new Date().toISOString();
    setTabs(current => current.map(chat => chat.id === id ? { ...chat, updatedAt } : chat));
    setSessions(current => current.map(chat => chat.id === id ? { ...chat, updatedAt } : chat));
  }
  function pauseQueue(id: string) {
    if (queuesRef.current[id]?.length) setPausedQueues(current => current.has(id) ? current : new Set(current).add(id));
  }
  /**
   * Sends to the open chat, or with `session`, to a chat in the background (queued
   * follow-ups). A queued message that fails goes back to its queue, not the composer.
   */
  async function send(prompt: string, filesOverride?: Attachment[], { session, queued = false }: { session?: string; queued?: boolean } = {}) {
    const promptSession = session ?? activeSession.current;
    const background = promptSession !== activeSession.current;
    if (!api || !promptSession || lock.current || running.current.has(promptSession)) throw new Error("Wait for your chat to be ready.");
    const pendingSettings = !background && configPending.current ? configTail.current : undefined;
    // Background sends must not invalidate a send the person is making in the open chat.
    const promptOperation = background ? operation.current : ++operation.current;
    if (!background) markChatRead(promptSession);
    const localId = `local-${crypto.randomUUID()}`;
    const files = filesOverride ?? attachments;
    running.current.add(promptSession); setRunningSessions(new Set(running.current));
    if (!background) { setError(""); setNotice(""); }
    setFailedPrompt(current => current?.session === promptSession ? undefined : current);
    clearIssue(promptSession);
    const shownFiles = files.map(file => ({ name: file.name, mimeType: file.mimeType, size: file.size, data: file.mimeType.startsWith("image/") ? file.data : undefined, uri: file.uri?.startsWith("file:") ? file.uri : undefined }));
    const addMessage = (current: Conversation): Conversation => ({ ...current, recovery: undefined, canContinue: false, entries: [...current.entries, { id: localId, kind: "user", text: prompt, attachments: shownFiles }] });
    const removeMessage = (current: Conversation): Conversation => ({ ...current, entries: current.entries.filter(entry => entry.id !== localId) });
    if (background) {
      // A background chat's transcript lives in the cache until it is opened again.
      if (!chatCache.current.has(promptSession) && api.readSession) {
        try { chatCache.current.set(promptSession, readConversation(await api.readSession(promptSession), chatPreferences[promptSession]?.title || "Chat")); }
        catch { /* Opening the chat reads its history again. */ }
      }
      chatCache.current.set(promptSession, addMessage(chatCache.current.get(promptSession) ?? emptyConversation()));
    } else setConversation(addMessage);
    if (filesOverride === undefined) { setAttachments([]); setRejectedFiles([]); }
    let dispatched = false;
    try {
      if (pendingSettings && !await pendingSettings) throw new Error("The setting change failed. Choose a provider and try again.");
      if (!background && promptOperation !== operation.current && activeSession.current === promptSession) {
        setConversation(removeMessage);
        if (queued) throw new Error("The queued message was held back.");
        setDraft(prompt); setAttachments(files);
        return;
      }
      dispatched = true;
      touchChat(promptSession);
      // Continuing an archived chat means it is not finished, so it returns to Chats.
      if (chatPreferences[promptSession]?.archived) void api.updateChat(promptSession, { archived: false }).then(preference => setChatPreferences(current => ({ ...current, [promptSession]: preference }))).catch(() => { /* It stays under Archived. */ });
      const result = record(await api.prompt(prompt, files, promptSession));
      const reason = text(result.stopReason);
      if (reason === 'end_turn' && activeSession.current !== promptSession) {
        setUnreadSessions(current => new Set(current).add(promptSession));
      }
      if (activeSession.current === promptSession && !result.recoveryPaused && reason && reason !== "end_turn" && reason !== "cancelled") {
        const message = `Response ended early: ${reason.replaceAll("_", " ")}.`;
        setNotice(message);
        setNoticeAction({ notice: message, label: "Try again", run: () => void latest.current.retryLast() });
      }
      // Follow-ups wait when a reply did not finish cleanly, so they never build on a broken turn.
      if (reason !== "end_turn" || result.recoveryPaused) pauseQueue(promptSession);
      if (reason && reason !== "end_turn" && reason !== "cancelled" && !result.recoveryPaused) setChatIssues(current => ({ ...current, [promptSession]: { kind: "interrupted", message: `Reply ended early: ${reason.replaceAll("_", " ")}.` } }));
    } catch (cause) {
      pauseQueue(promptSession);
      setChatIssues(current => ({ ...current, [promptSession]: { kind: "failed", message: cleanError(cause) } }));
      // A failed queued message returns to its queue, so the transcript does not show it twice.
      if (!dispatched || queued) {
        if (activeSession.current === promptSession) setConversation(removeMessage);
        else if (chatCache.current.has(promptSession)) chatCache.current.set(promptSession, removeMessage(chatCache.current.get(promptSession)!));
      }
      if (queued) {
        if (activeSession.current === promptSession) setError(cause instanceof Error ? cause.message : String(cause));
      } else if (activeSession.current === promptSession) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        setAttachments(current => current.length ? current : files);
        // A prompt the engine received can be tried again from the error.
        if (dispatched) setFailedPrompt({ session: promptSession, text: prompt, files, error: message });
      } else {
        const saved = drafts.current.get(promptSession);
        drafts.current.set(promptSession, { text: saved?.text || prompt, files: saved?.files.length ? saved.files : files });
      }
      throw cause;
    } finally {
      running.current.delete(promptSession); setRunningSessions(new Set(running.current));
      permissionCache.current.delete(promptSession);
      if (activeSession.current === promptSession) setPermissions([]);
    }
    // Updating the sidebar must not keep a completed response loading or block the next prompt.
    void refreshSessions(api).catch(() => { /* History refresh failures do not invalidate the completed turn. */ });
  }
  const focusComposer = () => requestAnimationFrame(() => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-slot="prompt-bar-input"]');
    input?.focus(); input?.setSelectionRange(input.value.length, input.value.length);
  });
  /** Saved prompts land in the composer, after any text already there. */
  function insertPrompt(body: string) {
    setDraft(current => current.trim() ? `${current.trimEnd()}\n\n${body}` : body);
    setFillingPrompt(undefined); setLibrary({ open: false });
    focusComposer();
  }
  function usePrompt(prompt: SavedPrompt) {
    setLibrary({ open: false });
    if (promptVariables(prompt.text).length) setFillingPrompt(prompt);
    else insertPrompt(prompt.text);
  }
  async function captureScreenshot() {
    if (!api?.captureScreen || capturing || attachments.length >= 10) return;
    setCapturing(true); setError("");
    try {
      const shot = await api.captureScreen();
      if (shot) { stageFiles([shot]); focusComposer(); }
    } catch (cause) { setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); }
    finally { setCapturing(false); }
  }
  /** Exports, then offers to show the file it wrote. */
  async function exportChat(scope: "current" | "all", format: "markdown" | "json") {
    if (!api) return;
    try {
      const result = await api.exportChats(scope, format);
      if (result.cancelled) return;
      const message = `Exported ${result.count} chat${result.count === 1 ? "" : "s"} as ${format === "markdown" ? "Markdown" : "JSON"}.`;
      setNotice(message);
      if (result.path) { const file = result.path; setNoticeAction({ notice: message, label: isMac ? "Show in Finder" : "Show in folder", run: () => void api.revealFile(file).catch(() => {}) }); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  /** Restored chats, prompts, projects, drafts, and queues join what is already open. */
  async function afterRestore(result: RestoreResult) {
    if (!api) return;
    void refreshSessions(api).catch(() => {});
    if (result.prompts) void api.listPrompts().then(setPrompts).catch(() => {});
    if (result.projects) void api.listProjects().then(setProjects).catch(() => {});
    if (result.drafts) {
      for (const entry of await api.listDrafts().catch(() => [])) {
        if (drafts.current.get(entry.id)?.text || drafts.current.get(entry.id)?.files.length || entry.id === activeSession.current) continue;
        drafts.current.set(entry.id, { text: entry.text, files: entry.files });
        savedDrafts.current.set(entry.id, draftKey(entry.text, entry.files));
      }
    }
    if (result.queued) {
      const { queues: merged, added } = mergeQueues(queuesRef.current, await api.listQueues().catch(() => []));
      for (const id of added) savedQueues.current.set(id, queueKey(merged[id], true));
      setQueues(merged);
      setPausedQueues(current => new Set([...current, ...added]));
      setRestoredQueues(current => new Set([...current, ...added]));
    }
  }
  const openFind = (query?: string) => setFind(current => ({ open: true, query: query ?? current.query, focus: current.focus + 1 }));
  /** Edit and Try again save another version within the same chat. */
  async function regenerate(id: string, editedText: string, reason: "edit" | "retry") {
    if (!api || lock.current || busy || !sessionId) throw new Error("Wait for the current response to finish before editing.");
    const users = conversation.entries.filter(entry => entry.kind === "user");
    const index = users.findIndex(entry => entry.id === id);
    if (index < 0) throw new Error("This message is no longer in the active chat.");
    const previous = conversation;
    const oldSession = sessionId;
    lock.current = true;
    setWorking(true); setError(""); setPermissions([]);
    activeSession.current = "";
    setConversation(emptyConversation());
    try {
      const result = await api.rewindSession(index, users[index].rawText ?? users[index].text);
      // The new version takes the original's tab; the original stays one click away.
      setTabs(current => current.map(tab => tab.id === oldSession ? { ...tab, id: result.sessionId, updatedAt: new Date().toISOString() } : tab));
      const branch = result.branch;
      if (branch) setChatPreferences(current => {
        const { title, pinned, archived } = current[oldSession] ?? {};
        return { ...current, [result.sessionId]: { ...current[result.sessionId], branch, title, pinned, archived } };
      });
      acceptSession(result);

    } catch (cause) {
      activeSession.current = oldSession;
      setConversation(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally { lock.current = false; setWorking(false); }
    const stagedFiles = attachments;
    const branch = activeSession.current;
    // Sending clears notices, so the note about the earlier version follows the new reply.
    const announce = () => {
      if (activeSession.current !== branch) return;
      const message = reason === "retry" ? "The previous reply is saved as another version. Switch versions with the arrows under your message. File changes and commands it made remain." : "Your previous message is saved as another version. Switch versions with the arrows under it. Earlier file changes and commands remain.";
      setNotice(message);
      setNoticeAction({ notice: message, label: "Open previous version", run: () => latest.current.openVersion(oldSession) });
    };
    await send(editedText, []).then(announce, cause => { announce(); throw cause; }).finally(() => setAttachments(stagedFiles));
  }
  const editMessage = (id: string, editedText: string) => regenerate(id, editedText, "edit");
  useEffect(() => { latest.current = { retryLast, openVersion }; });
  const lastUserEntry = conversation.entries.findLast(entry => entry.kind === "user");
  // The engine regenerates text-only turns; attachments have to be sent again.
  const canRegenerate = !!lastUserEntry && !lastUserEntry.attachments?.length;
  async function continueResponse() {
    const target = activeSession.current;
    if (!api || !target || lock.current || running.current.has(target)) return;
    running.current.add(target); setRunningSessions(new Set(running.current));
    setError(''); setNotice(''); clearIssue(target);
    try {
      touchChat(target);
      await api.continueResponse(target);
    } catch (cause) {
      if (activeSession.current === target) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current.delete(target); setRunningSessions(new Set(running.current));
      permissionCache.current.delete(target);
      if (activeSession.current === target) setPermissions([]);
      void refreshSessions(api).catch(() => {});
    }
  }
  async function retryLast() {
    if (conversation.canContinue) { await continueResponse(); return; }
    const failed = failedPrompt?.session === activeSession.current ? failedPrompt : undefined;
    setFailedPrompt(undefined); setError(""); setNotice("");
    if (lastUserEntry && canRegenerate) {
      try { await regenerate(lastUserEntry.id, lastUserEntry.text, "retry"); return; }
      catch { if (!failed) return; /* A failed turn the engine never saved is sent again below. */ }
    }
    if (!failed) return;
    // The failed message was put back in the composer; it is sent from here instead.
    setDraft(current => current.trim() === failed.text.trim() ? "" : current);
    setAttachments(current => current.length === failed.files.length && current.every((file, index) => file === failed.files[index]) ? [] : current);
    await send(failed.text, failed.files).catch(() => { /* send() reports the failure. */ });
  }

  /** Closing a tab only hides it; the chat stays in the sidebar. */
  function closeTab(id: string) {
    const closing = tabs.find(tab => tab.id === id);
    if (closing) closedTabs.current = rememberClosed(closedTabs.current, closing);
    const remaining = tabs.filter(tab => tab.id !== id);
    setTabs(remaining);
    if (id !== sessionId) return;
    const index = tabs.findIndex(tab => tab.id === id);
    const neighbour = remaining[Math.min(index, remaining.length - 1)];
    if (neighbour) openChat({ ...neighbour, label: chatPreferences[neighbour.id]?.title || neighbour.label });
    else void sessionAction("chat");
  }
  async function cancel() {
    ++operation.current;
    // Stopping a reply also holds any queued follow-ups until the person resumes them.
    pauseQueue(sessionId);
    try { await api?.cancel(sessionId); setPermissions([]); }
    catch (cause) { setError(String(cause)); }
  }
  async function deleteSession(id: string) {
    const ids = chatIds(id);
    if (!api || lock.current || [...ids].some(target => running.current.has(target))) throw new Error("Handwork is busy. Try again when it finishes.");
    lock.current = true; setWorking(true); setError(""); setNotice("");
    try {
      for (const target of ids) {
        await api.deleteSession(target);
        chatCache.current.delete(target);
        editQueue(target, () => []);
        clearIssue(target);
        setTabs(current => current.filter(tab => tab.id !== target));
        setSessions(current => current.filter(session => session.id !== target));
      }
      if (ids.has(sessionId)) {
        // The engine released the deleted session; continue in a fresh one.
        activeSession.current = ""; setSessionId(""); setConversation(emptyConversation()); setPermissions([]);
        activeWorkspace.current = ''; setWorkspace('');
        acceptSession(await api.newChat());
      }
      await refreshSessions(api);
    } finally { lock.current = false; setWorking(false); }
  }
  async function deleteProject() {
    if (!api || !projectToDelete || deletingProject) return;
    setDeletingProject(true); setProjectDeleteError("");
    try {
      setProjects(await api.removeProject(projectToDelete));
      setProjectToDelete(undefined);
    } catch (cause) { setProjectDeleteError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDeletingProject(false); }
  }
  function chatIds(id: string) {
    const workspace = recents.find(chat => chat.id === id)?.workspace;
    return chatVersionIds(chatPreferences, id, new Set(recents.filter(chat => chat.workspace === workspace).map(chat => chat.id)));
  }
  async function updateChatVersions(id: string, changes: { title?: string; pinned?: boolean; archived?: boolean }) {
    if (!api) return;
    for (const target of chatIds(id)) {
      const preference = await api.updateChat(target, changes);
      setChatPreferences(current => ({ ...current, [target]: preference }));
    }
  }
  async function pinChat(chat: SavedSession) {
    if (!api || blocked) return;
    try {
      await updateChatVersions(chat.id, { pinned: !chat.pinned });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  /** Archived chats leave the sidebar lists but stay searchable. An open chat stays open. */
  async function archiveChat(chat: SavedSession, archived: boolean) {
    if (!api) return;
    const ids = chatIds(chat.id);
    if (archived && [...ids].some(id => running.current.has(id))) { setNotice("Wait for this chat to finish before archiving it."); return; }
    try {
      await updateChatVersions(chat.id, { archived });
      if (archived) setTabs(current => current.filter(tab => !ids.has(tab.id) || tab.id === shownSession));
      const message = archived ? `Archived “${chat.label}”. Find it under Archived or search with ${shortcutLabel("Mod+K")}.` : `Restored “${chat.label}”.`;
      setNotice(message);
      setNoticeAction(archived ? { notice: message, label: "Undo", run: () => void archiveChat(chat, false) } : undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  /** Switches to another version of this chat in the same tab. */
  function openVersion(id: string) {
    const target = recents.find(chat => chat.id === id);
    if (!target || blocked || busy) return;
    const from = shownSession;
    setTabs(current => current.some(tab => tab.id === id) ? current : current.map(tab => tab.id === from ? { id: target.id, label: target.label, workspace: target.workspace, updatedAt: target.updatedAt } : tab));
    openChat(target);
  }
  /** A model on another provider switches the provider first, which changes the models offered. */
  function chooseModel(target: ModelShortcut) {
    const changes: ConfigChange[] = [];
    if (target.provider !== (options.find(option => option.id === "provider")?.currentValue ?? "")) changes.push(['provider', target.provider]);
    changes.push(['model', target.model]);
    return configureChanges(changes);
  }
  async function favoriteModel(favorite: boolean) {
    const model = options.find(option => option.id === "model");
    if (!api?.setModelFavorite || !model) return;
    const name = model.options.find(choice => choice.value === model.currentValue)?.name ?? model.currentValue;
    try { setModelPreferences(await api.setModelFavorite(options.find(option => option.id === "provider")?.currentValue ?? "", model.currentValue, name, favorite)); }
    catch (cause) { setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")); }
  }
  async function saveChatAction() {
    if (!api || !chatAction || savingChat) return;
    setSavingChat(true); setChatActionError("");
    try {
      if (chatAction.kind === "delete") await deleteSession(chatAction.chat.id);
      else {
        await updateChatVersions(chatAction.chat.id, { title: chatName.trim() });
      }
      setChatAction(undefined);
    } catch (cause) { setChatActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSavingChat(false); }
  }
  /** Adapt the terminal registry to native controls. Never send commands as model prompts. */
  async function runCommand(name: string, args: string) {
    const action = resolveSlashCommand(name, args, composerOptions);
    setNotice('');
    switch (action.kind) {
      case 'notice': setNotice(action.message); break;
      case 'commands': setPalettePage('commands'); setPaletteOpen(true); break;
      case 'new': await sessionAction(workspace ? 'project' : 'chat', workspace || undefined); break;
      case 'resume': setPalettePage(''); setPaletteOpen(true); break;
      case 'settings': setSettingsSection(action.section); setSettingsOpen(true); break;
      case 'report': setReportCommand(action.command); break;
      case 'rename':
        if (!activeChat) { setNotice('Start a chat before renaming it.'); break; }
        setChatAction({ kind: 'rename', chat: activeChat }); setChatName(action.title || activeChat.label); setChatActionError(''); break;
      case 'copy': {
        const reply = shownConversation.entries.findLast(entry => entry.kind === 'assistant');
        if (!reply?.text) { setNotice('There is no assistant response to copy yet.'); break; }
        await navigator.clipboard.writeText(reply.text); setNotice('Response copied.'); break;
      }
      case 'diff':
        if (!workspace) { setNotice('Open a project to review its changes.'); break; }
        setActivityOpen(false); setChangesOpen(true); break;
      case 'export': await exportChat('current', 'markdown'); break;
      case 'activity': setChangesOpen(false); setActivityOpen(true); setActivityRequested(true); break;
      case 'choices': setPalettePage(action.optionId); setPaletteOpen(true); break;
      case 'configure': await configure(action.optionId, action.value); break;
    }
  }
  function configure(id: string, value: string) {
    return configureChanges([[id, value]]);
  }
  function configureChanges(changes: ConfigChange[]) {
    if (!api || lock.current || running.current.has(activeSession.current)) return;
    const bridge = api;
    const version = ++configVersion.current;
    configPending.current = true; setConfiguring(true); setError("");
    setOptions(current => {
      let next = current;
      for (const [id, value] of changes) {
        if (id !== 'provider') next = next.map(option => option.id === id ? { ...option, currentValue: value } : option);
        else {
          const dependent = new Set(['model', 'effort', 'fast_mode']);
          const cached = providerOptions.current.get(value) ?? [];
          next = [...next.filter(option => !dependent.has(option.id)).map(option => option.id === id ? { ...option, currentValue: value } : option), ...cached.filter(option => dependent.has(option.id))];
        }
      }
      return next;
    });
    // Enqueue the complete selection synchronously, including its dependent model.
    const next = queueConfiguration(configTail.current, changes, async (id, value) => {
      const result = configOptions(record(await bridge.setConfig(id, value)).configOptions);
      rememberOptions(result);
      return result;
    }).then(results => {
      if (version === configVersion.current && results.length) setOptions(results[results.length - 1]);
      return true;
    }).catch(cause => {
      if (version === configVersion.current) {
        setOptions(confirmedOptions.current);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return false;
    }).finally(() => {
      if (version === configVersion.current) { configPending.current = false; setConfiguring(false); }
    });
    configTail.current = next;
    return next;
  }
  async function answerPermission(id: string | number, optionId: string | null) {
    if (!api || answering) return;
    setAnswering(true);
    try { await api.respondPermission(id, optionId, sessionId); setPermissions(current => current.filter(p => p.id !== id)); }
    catch (cause) { setError(String(cause)); throw cause; }
    finally { setAnswering(false); }
  }
  const shownConversation = pendingChat ? chatCache.current.get(pendingChat.id) ?? (historyPreview?.id === pendingChat.id ? historyPreview.conversation : { ...emptyConversation(), title: pendingChat.label }) : conversation;
  const shownSession = pendingChat?.id ?? sessionId;
  const shownUsage = withSavedUsage(shownConversation, chatPreferences[shownSession]?.usage);
  const showProjectTools = !!workspace && (!pendingChat || pendingChat.workspace === workspace);
  const unavailable = !api || !sessionId || !!pendingChat;
  const blocked = working || configuring || picking || navigating || recoveringDraft || !!pendingChat;
  const tools = shownConversation.entries.filter(entry => entry.kind === "tool");
  const projectChangeState = useProjectChanges(api, workspace);
  const changes = projectChangeState.snapshot?.files ?? [];
  const changesComplete = !projectChangeState.snapshot?.truncated && changes.every(file => file.complete && !file.binary);
  const addedLines = changes.reduce((total, file) => total + file.added, 0);
  const removedLines = changes.reduce((total, file) => total + file.removed, 0);
  const closeReviewPanel = () => {
    document.getElementById(changesOpen ? 'handwork-changes-trigger' : 'handwork-activity-trigger')?.focus();
    setChangesOpen(false); setActivityOpen(false); setActivityRequested(false);
  };
  const provider = options.find(option => option.id === "provider");
  const openProject = () => void sessionAction("open");
  // Merge saved activity into open tabs, then sort every sidebar group by recency.
  const recents: SavedSession[] = sortChatsByRecency(mergeSidebarChats(
    tabs.map(tab => isPlaceholderTitle(tab.label) ? { ...tab, label: sessions.find(session => session.id === tab.id)?.label ?? tab.label } : tab),
    sessions, projects,
  ).map(chat => ({ ...chat, label: chatPreferences[chat.id]?.title || chatTitle(chat.label, (chat.id === sessionId ? conversation : chatCache.current.get(chat.id))?.entries.find(entry => entry.kind === 'user')?.text), pinned: chatPreferences[chat.id]?.pinned ?? chat.pinned ?? false, archived: chatPreferences[chat.id]?.archived ?? chat.archived ?? false })));
  const chatRows = collapseChatVersions(recents, chatPreferences, shownSession);
  const workspaceName = workspace.split("/").filter(Boolean).pop() || workspace;
  const landing = !pendingChat && conversation.entries.length === 0 && !busy;
  const suggestionRoute = JSON.stringify(options.filter(option => ["provider", "model", "effort", "fast_mode"].includes(option.id)).map(option => [option.id, option.currentValue]));
  const suggestionKey = workspace + suggestionRoute;
  useEffect(() => {
    if (!api || !workspace || !sessionId || !landing || working || configuring || picking || lock.current || settingsOpen || preferences?.effective.suggestions === false) return;
    let current = true;
    setSuggestionState({ key: suggestionKey, items: [], status: "loading" });
    void api.projectSuggestions().then(items => {
      if (current) setSuggestionState({ key: suggestionKey, items, status: "ready" });
    }).catch(() => {
      if (current) setSuggestionState({ key: suggestionKey, items: [], status: "failed" });
    });
    return () => { current = false; };
  }, [api, sessionId, landing, working, configuring, picking, suggestionKey, suggestionRetry, preferences?.effective.suggestions, settingsOpen]);
  const projectSuggestions = suggestionState.key === suggestionKey ? suggestionState.items : [];
  const orphanDrafts = recoveredDrafts.filter(entry => !recents.some(chat => chat.id === entry.id));
  const draftRestored = restoredDraft?.session === sessionId && restoredDraft.key === draftKey(draft, attachments);
  useEffect(() => {
    if (restoredDraft && !draftRestored) setRestoredDraft(undefined);
  }, [restoredDraft, draftRestored]);
  // Drafts save shortly after typing stops, and immediately when the chat changes.
  const draftSession = sessionId && !pendingChat && !working ? sessionId : "";
  function flushDraft() {
    const pending = pendingDraft.current;
    pendingDraft.current = undefined;
    if (!pending || !api?.saveDraft) return;
    savedDrafts.current.set(pending.id, pending.key);
    return api.saveDraft(pending.id, pending.text, pending.files).then(result => {
      if (!result.saved || result.skipped) throw new Error('Draft storage is full.');
    }).catch(() => {
      if (savedDrafts.current.get(pending.id) === pending.key) savedDrafts.current.delete(pending.id);
      setNotice('Your draft could not be saved. Keep this chat open and remove attachments or free storage space.');
    });
  }
  useEffect(() => {
    if (!api?.saveDraft || !startupReady || !draftSession) return;
    if (pendingDraft.current && pendingDraft.current.id !== draftSession) flushDraft();
    const key = draftKey(draft, attachments);
    const previous = savedDrafts.current.get(draftSession) ?? draftKey("", []);
    if (key === previous) { pendingDraft.current = undefined; return; }
    const filesChanged = key.slice(key.indexOf("\u0000")) !== previous.slice(previous.indexOf("\u0000"));
    pendingDraft.current = { id: draftSession, text: draft, files: filesChanged ? attachments : null, key };
    const timer = setTimeout(flushDraft, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, startupReady, draftSession, draft, attachments]);
  useEffect(() => {
    const flush = () => flushDraft();
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  });
  async function recoverDraft(entry: SavedDraft) {
    if (!api?.moveDraft || !sessionId || blocked || lock.current || draft || attachments.length) return;
    lock.current = true; setRecoveringDraft(true);
    try {
      // Commit a just-cleared composer before refusing to replace its saved draft.
      await flushDraft();
      const result = await api.moveDraft(entry.id, sessionId);
      if (!result.saved) throw new Error('This draft could not be restored. Its original is still saved.');
      pendingDraft.current = undefined;
      savedDrafts.current.delete(entry.id);
      drafts.current.delete(entry.id);
      savedDrafts.current.set(sessionId, draftKey(entry.text, entry.files));
      drafts.current.set(sessionId, { text: entry.text, files: entry.files });
      setDraft(entry.text); setAttachments(entry.files);
      setRecoveredDrafts(current => current.filter(item => item.id !== entry.id));
      setRestoredDraft({ session: sessionId, key: draftKey(entry.text, entry.files) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { lock.current = false; setRecoveringDraft(false); }
  }
  // Restore one into an empty composer. Every other draft remains on disk and in the picker.
  useEffect(() => {
    if (!startupReady || !sessionId || working || draft || attachments.length) return;
    const restored = orphanDrafts[0];
    if (restored) void recoverDraft(restored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startupReady, sessionId, working]);
  // Clicking a notification opens the chat it is about.
  useEffect(() => {
    if (!chatRequest || !startupReady) return;
    const chat = recents.find(item => item.id === chatRequest) ?? tabs.find(item => item.id === chatRequest);
    setChatRequest(undefined);
    if (chat && chat.id !== shownSession) openChat({ ...chat, label: chatPreferences[chat.id]?.title || chat.label });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatRequest, startupReady]);
  // Queued follow-ups send one at a time once their chat's reply finishes, in that chat,
  // even while the person reads another one.
  const queue = queues[sessionId] ?? [];
  const queuePaused = pausedQueues.has(sessionId);
  const queuedCounts = queueCounts(queues);
  const queuedCommand = (item: QueuedMessage) => !item.files.length && !!parseSlashCommand(item.text);
  function editQueue(id: string, change: (items: QueuedMessage[]) => QueuedMessage[]) {
    setQueues(current => {
      const items = change(current[id] ?? []);
      const next = { ...current };
      if (items.length) next[id] = items; else delete next[id];
      return next;
    });
  }
  function resumeQueue(id: string) {
    setPausedQueues(current => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
    setRestoredQueues(current => { if (!current.has(id)) return current; const next = new Set(current); next.delete(id); return next; });
  }
  function dispatchQueued(target: string, next: QueuedMessage) {
    editQueue(target, items => items.filter(item => item.id !== next.id));
    const command = queuedCommand(next) ? parseSlashCommand(next.text) : null;
    const task = command ? runCommand(command.name, command.args) : send(next.text, next.files, { session: target, queued: true });
    void task.catch(cause => {
      // Keep the message and stop sending the rest until the person decides.
      editQueue(target, items => [next, ...items.filter(item => item.id !== next.id)]);
      setPausedQueues(current => new Set(current).add(target));
      if (activeSession.current !== target) {
        setUnreadSessions(current => new Set(current).add(target));
        const label = chatPreferences[target]?.title || recents.find(chat => chat.id === target)?.label || "another chat";
        setNotice(`A queued message in “${label}” could not send, so its queue is paused. ${(cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
      }
    });
  }
  useEffect(() => {
    if (!api || lock.current || working || navigating) return;
    const ready = readyQueues({ queues, paused: pausedQueues, running: running.current, active: sessionId, activeBlocked: blocked || !sessionId, opening: pendingChat?.id, isCommand: queuedCommand });
    for (const { session, item } of ready) dispatchQueued(session, item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queues, pausedQueues, api, runningSessions, blocked, working, navigating, sessionId, pendingChat]);
  // An emptied queue forgets that it was paused, so the next follow-up sends normally.
  useEffect(() => {
    for (const id of new Set([...pausedQueues, ...restoredQueues])) if (!queues[id]?.length) resumeQueue(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queues]);
  // Every change to a queue is saved at once, so quitting never loses queued work.
  useEffect(() => {
    if (!api?.saveQueue || !queuesLoaded.current) return;
    for (const id of new Set([...Object.keys(queues), ...savedQueues.current.keys()])) {
      const items = queues[id] ?? [];
      const paused = pausedQueues.has(id);
      const key = queueKey(items, paused);
      if ((savedQueues.current.get(id) ?? "") === key) continue;
      if (key) savedQueues.current.set(id, key); else savedQueues.current.delete(id);
      void api.saveQueue(id, { paused, items }).catch(() => {
        savedQueues.current.delete(id);
        setNotice("Queued messages could not be saved. They still send while Handwork stays open.");
      });
    }
  }, [api, queues, pausedQueues]);
  // Queues saved before a restart are announced once the first chat is open.
  useEffect(() => {
    const count = restoredQueueCount.current;
    if (!count || !startupReady || !sessionId || working) return;
    restoredQueueCount.current = 0;
    setNotice(`${count} queued message${count === 1 ? " was" : "s were"} saved when Handwork closed. ${count === 1 ? "It is" : "They are"} paused so you can review before sending.`);
  }, [startupReady, sessionId, working]);
  // Chats that need the person (approvals, failed or paused replies, paused queues), then working chats.
  const approvalCounts = new Map<string, number>();
  for (const [id, list] of permissionCache.current) if (id !== sessionId && list.length) approvalCounts.set(id, list.length);
  if (sessionId && permissions.length) approvalCounts.set(sessionId, permissions.length);
  const recoverable = new Set<string>([...chatCache.current].filter(([id, cached]) => id !== sessionId && cached.canContinue).map(([id]) => id));
  if (sessionId && conversation.canContinue) recoverable.add(sessionId);
  const attention = attentionItems({
    chats: [...recents, ...tabs], approvals: approvalCounts, issues: chatIssues, recoverable, running: runningSessions, queued: queuedCounts,
    pausedQueues: new Map([...pausedQueues].filter(id => queues[id]?.length).map(id => [id, queues[id].length])),
  });
  const attentionKinds = new Map(attention.map(item => [item.id, item.kind]));
  function clearIssue(id: string) {
    setChatIssues(current => { if (!Object.hasOwn(current, id)) return current; const next = { ...current }; delete next[id]; return next; });
  }
  /** Opens the chat and puts focus on the control that resolves what it is waiting for. */
  function openAttention(item: AttentionItem) {
    setAttentionFocus({ id: item.id, kind: item.kind });
    if (item.id === shownSession) return;
    const chat = recents.find(entry => entry.id === item.id) ?? tabs.find(entry => entry.id === item.id) ?? { id: item.id, label: item.label, workspace: item.workspace };
    openChat({ ...chat, label: chatPreferences[chat.id]?.title || chat.label });
  }
  function goToNextAttention() {
    const next = nextAttention(attention, shownSession);
    if (next) openAttention(next);
    else setNotice("Nothing needs you right now.");
  }
  useEffect(() => {
    const target = attentionFocus;
    if (!target || pendingChat || working || navigating || sessionId !== target.id) return;
    setAttentionFocus(undefined);
    const issue = chatIssues[target.id];
    // A reason recorded while the chat was in the background is shown once it is open.
    if (target.kind === 'failed' && issue && !error) setError(issue.message);
    if (target.kind === 'interrupted' && issue && !conversation.canContinue) {
      setNotice(issue.message);
      setNoticeAction({ notice: issue.message, label: "Try again", run: () => { clearIssue(target.id); void latest.current.retryLast(); } });
    }
    const controls: Record<AttentionKind, string> = {
      approval: '[data-attention="approval"] :is([role="radio"][tabindex="0"], [role="checkbox"], textarea, button:not([disabled]))',
      failed: '[data-attention="queue"] [data-primary], [data-attention="error"] button:not([disabled])',
      interrupted: '[data-attention="recovery"] button:not([disabled]), [data-attention="notice"] button:not([disabled])',
      queue: '[data-attention="queue"] [data-primary]',
      running: '',
    };
    // Wait for the opened chat to render its controls.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const control = controls[target.kind] ? document.querySelector<HTMLElement>(controls[target.kind]) : null;
      if (!control) { focusComposer(); return; }
      control.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      control.focus();
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attentionFocus, pendingChat, working, navigating, sessionId]);
  /** Tab, chat, and attention actions from the keyboard or the app menu. */
  function runTabAction(action: TabAction) {
    // Native accelerators bypass the page's key handler and must obey its modal guard too.
    if (settingsOpen || recoveringDraft || lock.current || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    // A shortcut can reach both the menu and the page; act on it once.
    const now = Date.now();
    if (lastTabAction.current.action === action && now - lastTabAction.current.at < 200) return;
    lastTabAction.current = { action, at: now };
    const open = (chat: SavedSession) => { if (chat.id !== shownSession) openChat({ ...chat, label: chatPreferences[chat.id]?.title || chat.label }); };
    switch (action) {
      case 'new': if (!blocked && api) void sessionAction("chat"); break;
      case 'next': case 'previous': { const tab = adjacentTab(tabs, shownSession, action === 'next' ? 1 : -1); if (tab && !picking) open(tab); break; }
      case 'close': if (!blocked && tabs.some(tab => tab.id === shownSession)) closeTab(shownSession); break;
      case 'reopen': {
        const { tab, rest } = reopenCandidate(closedTabs.current, tabs.map(item => item.id), id => recents.some(chat => chat.id === id));
        closedTabs.current = rest;
        if (!tab) { setNotice("There is no closed tab to reopen."); break; }
        setTabs(current => current.some(item => item.id === tab.id) ? current : [...current, tab]);
        open(tab);
        break;
      }
      case 'attention': goToNextAttention(); break;
      case 'details': setDetailsOpen(true); break;
      default: { const tab = numberedTab(tabs, Number(action)); if (tab && !picking) open(tab); }
    }
  }
  useEffect(() => {
    if (!tabRequest) return;
    setTabRequest(undefined);
    runTabAction(tabRequest.action);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabRequest]);
  // Quick entry prompts always start a fresh standalone chat.
  useEffect(() => {
    if (!quickPrompt || !api || blocked || lock.current) return;
    const prompt = quickPrompt;
    setQuickPrompt(undefined);
    void (async () => {
      await sessionAction("chat");
      if (activeSession.current) await send(prompt.text, prompt.attachments);
      else { setDraft(prompt.text); setAttachments(prompt.attachments); }
    })().catch(() => { /* send() already reports the failure and restores the draft. */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickPrompt, api, blocked]);
  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.altKey) return;
      const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
      const run = (action: TabAction) => { event.preventDefault(); runTabAction(action); };
      // Control+Tab switches tabs on every platform, as in browsers.
      if (event.ctrlKey && !event.metaKey && event.code === 'Tab') { if (!dialog) run(event.shiftKey ? 'previous' : 'next'); return; }
      if (!(isMac ? event.metaKey : event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey) {
        if (dialog || event.repeat) return;
        if (event.code === 'BracketRight') run('next');
        else if (event.code === 'BracketLeft') run('previous');
        else if (key === 't') run('reopen');
        else if (key === 'a') run('attention');
        return;
      }
      if (event.repeat) return;
      // Dialogs keep their own keyboard behaviour.
      if (dialog && key !== 'f') return;
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (digit) run(digit as TabAction);
      else if (key === 'f' && !document.querySelector('[role="dialog"]')) { event.preventDefault(); openFind(); }
      else if (key === 'n') run('new');
      else if (key === 'w') run('close');
      else if (key === 'i') run('details');
      else if (key === '/') { event.preventDefault(); setShortcutsOpen(true); }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  });
  // Inside the Electron shell on macOS the system title bar is hidden; leave room for the traffic lights.
  const desktopMac = !!api && !fullscreen && typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent);
  const desktopWindows = !!api && !fullscreen && typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent);

  const composerOptions = options.filter(option => workspace || option.id !== "mode").map(option => option.id === "provider" ? { ...option, options: option.options.filter(choice => choice.value === option.currentValue || providers.some(item => item.id === choice.value && item.connected)) } : option);
  const activeChat = recents.find(chat => chat.id === sessionId);
  const viewedChat = recents.find(chat => chat.id === shownSession);
  const shortcuts = modelShortcuts(modelPreferences, composerOptions);
  // Versions are offered only between chats that can still be opened.
  const openableChats = new Set(recents.map(chat => chat.id));
  const versionFor = (turn: number): MessageVersion | undefined => {
    const position = versionPosition(chatPreferences, shownSession, turn, openableChats);
    if (!position) return undefined;
    const locked = blocked || busy;
    return { index: position.index, total: position.total, onPrevious: position.previous && !locked ? () => openVersion(position.previous!) : undefined, onNext: position.next && !locked ? () => openVersion(position.next!) : undefined };
  };
  const latestVersionTurn = activeChat ? versionTurns(chatPreferences, activeChat.id, openableChats).at(-1) : undefined;
  const latestVersion = activeChat && latestVersionTurn !== undefined ? versionPosition(chatPreferences, activeChat.id, latestVersionTurn, openableChats) : undefined;
  const currentModel = options.find(option => option.id === "model");
  const commandIcons: Record<string, ReactNode> = { model: <Gauge aria-hidden />, security: <Shield aria-hidden />, account: <Plug aria-hidden />, workspace: <FolderPlus aria-hidden />, session: <SquarePen aria-hidden />, general: <BookText aria-hidden /> };
  const slashItems = desktopSlashCommands.flatMap(command => [command.name, ...(command.showAliases ? command.aliases : [])].map(name => ({
    id: name, label: name, description: commands.find(item => item.name === command.name)?.description || command.description,
    hint: command.input, icon: commandIcons[command.category] || <SettingsIcon aria-hidden />,
  })));
  const paletteActions: PaletteAction[] = [
    ...desktopSlashCommands.map(command => ({ id: `slash:${command.name}`, label: `/${command.name}`, description: command.description, group: 'commands' as const, icon: commandIcons[command.category] || <SettingsIcon aria-hidden />, keywords: command.aliases.map(alias => `/${alias}`).join(' '), disabled: blocked || !api, run: () => { void runCommand(command.name, '').catch(cause => setError(String(cause))); } })),
    { id: "new-chat", label: "New chat", icon: <SquarePen aria-hidden />, shortcut: "Mod+N", keywords: "start conversation", disabled: blocked || !api, run: () => void sessionAction("chat") },
    { id: "open-project", label: "Open project…", icon: <FolderPlus aria-hidden />, keywords: "folder workspace add", disabled: blocked || !api, run: openProject },
    { id: "find", label: "Find in chat", icon: <TextSearch aria-hidden />, shortcut: "Mod+F", keywords: "search text conversation", disabled: !shownConversation.entries.length, run: () => openFind() },
    { id: 'slash-commands', label: 'Slash commands', icon: <BookText aria-hidden />, keywords: 'slash commands help', run: () => { setPalettePage('commands'); setPaletteOpen(true); } },
    { id: "prompts", label: "Saved prompts", icon: <BookText aria-hidden />, keywords: "library snippets templates", disabled: !api, run: () => setLibrary({ open: true }) },
    ...(draft.trim() ? [{ id: "save-prompt", label: "Save draft as prompt", icon: <Bookmark aria-hidden />, keywords: "snippet template library", run: () => setLibrary({ open: true, draft }) }] : []),
    { id: "screenshot", label: "Take screenshot", icon: <SquareDashedMousePointer aria-hidden />, keywords: "capture screen window region image attach", disabled: !api?.captureScreen || blocked || capturing || attachments.length >= 10, run: () => void captureScreenshot() },
    { id: "attach", label: "Attach files…", icon: <Paperclip aria-hidden />, keywords: "upload file image", disabled: !api || blocked, run: () => void addFiles() },
    ...(activeChat && conversation.entries.length ? [{ id: "rename", label: "Rename chat…", icon: <Pencil aria-hidden />, keywords: "title", disabled: blocked, run: () => { setChatAction({ kind: "rename", chat: activeChat }); setChatName(activeChat.label); setChatActionError(""); } }] : []),
    ...(activeChat && conversation.entries.length ? [activeChat.archived
      ? { id: "restore", label: "Restore chat", icon: <ArchiveRestore aria-hidden />, keywords: "unarchive archived", run: () => void archiveChat(activeChat, false) }
      : { id: "archive", label: "Archive chat", icon: <Archive aria-hidden />, keywords: "hide finished done", disabled: busy, run: () => void archiveChat(activeChat, true) }] : []),
    ...(recents.some(chat => chat.archived) ? [{ id: "archived", label: "Archived chats", icon: <Archive aria-hidden />, keywords: "archive hidden finished restore filter", run: () => { setPalettePage("archived"); setPaletteOpen(true); } }] : []),
    ...(latestVersion?.previous ? [{ id: "previous-version", label: "Previous version", description: `Version ${latestVersion.index} of ${latestVersion.total}`, icon: <History aria-hidden />, keywords: "regenerate retry edit original branch", disabled: blocked || busy, run: () => openVersion(latestVersion.previous!) }] : []),
    ...(latestVersion?.next ? [{ id: "next-version", label: "Newer version", description: `Version ${latestVersion.index + 2} of ${latestVersion.total}`, icon: <History aria-hidden />, keywords: "regenerate retry edit new branch", disabled: blocked || busy, run: () => openVersion(latestVersion.next!) }] : []),
    ...(currentModel && api?.setModelFavorite ? [{ id: "favorite-model", label: shortcuts.favorite ? "Remove model from favorites" : "Add model to favorites", description: modelDisplayName(currentModel.options.find(choice => choice.value === currentModel.currentValue)?.name ?? currentModel.currentValue), icon: <Star aria-hidden />, keywords: "favorite star pin model", run: () => void favoriteModel(!shortcuts.favorite) }] : []),
    { id: "export-markdown", label: "Export chat as Markdown", icon: <Download aria-hidden />, keywords: "save download share md document", disabled: !api || working || !conversation.entries.length, run: () => void exportChat("current", "markdown") },
    { id: "export-json", label: "Export chat as JSON", icon: <Download aria-hidden />, keywords: "save download backup data", disabled: !api || working || !conversation.entries.length, run: () => void exportChat("current", "json") },
    { id: "chat-details", label: "Chat details", icon: <Info aria-hidden />, shortcut: "Mod+I", keywords: "model provider instructions agents context tokens folders permissions attachments", disabled: !api || !sessionId, run: () => setDetailsOpen(true) },
    ...(attention.some(item => item.kind !== "running") ? [{ id: "next-attention", label: "Next chat that needs you", description: attention.find(item => item.kind !== "running")?.label, icon: <Hand aria-hidden />, shortcut: "Mod+Shift+A", keywords: "approval failed paused blocked attention", run: goToNextAttention }] : []),
    ...(closedTabs.current.length ? [{ id: "reopen-tab", label: "Reopen closed tab", icon: <History aria-hidden />, shortcut: "Mod+Shift+T", keywords: "undo close tab restore", run: () => runTabAction("reopen") }] : []),
    { id: "settings", label: "Settings", icon: <SettingsIcon aria-hidden />, shortcut: "Mod+,", keywords: "preferences options", run: () => setSettingsOpen(true) },
    { id: "shortcuts", label: "Keyboard shortcuts", icon: <Keyboard aria-hidden />, shortcut: "Mod+/", keywords: "keys hotkeys keybindings help reference", run: () => setShortcutsOpen(true) },
    ...(showProjectTools ? [
      { id: "activity", label: activityOpen ? "Hide activity" : "Show activity", icon: <Activity aria-hidden />, group: "view" as const, keywords: "tools panel", run: () => { setActivityOpen(value => !value); setChangesOpen(false); } },
      { id: "changes", label: changesOpen ? "Hide changes" : "Review changes", icon: <GitCompare aria-hidden />, group: "view" as const, keywords: "diff git files panel", run: () => { setChangesOpen(value => !value); setActivityOpen(false); } },
    ] : []),
  ];
  const pageIcons: Record<string, ReactNode> = { model: <Cpu aria-hidden />, provider: <Plug aria-hidden />, effort: <Gauge aria-hidden />, mode: <Shield aria-hidden /> };
  const pageLabels: Record<string, string> = { model: "Switch model", provider: "Switch provider", effort: "Reasoning effort", mode: "Session mode" };
  const palettePages: PaletteChoicePage[] = [
    ...composerOptions.filter(option => option.id in pageLabels && option.options.length > 0).map(option => ({ id: option.id, label: pageLabels[option.id], icon: pageIcons[option.id], option, disabled: busy || working || picking || navigating || unavailable })),
    { id: "theme", label: "Theme", icon: <SunMoon aria-hidden />, option: { id: "theme", name: "Theme", currentValue: preferences?.app.theme ?? "system", options: [{ value: "system", name: "System" }, { value: "light", name: "Light" }, { value: "dark", name: "Dark" }] } },
  ];

  const composer = <div className="handwork-composer" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => {
    event.preventDefault(); if (!blocked) void stageDroppedFiles(Array.from(event.dataTransfer.files)).catch(cause => setError(String(cause)));
  }}>
    {(draftRestored || recoveringDraft || orphanDrafts.length > 0) && <div className="handwork-draft-recovery">
      {(draftRestored || recoveringDraft) && <span role="status" className="handwork-draft-recovery-status"><RotateCcw aria-hidden width={14} height={14} />{recoveringDraft ? 'Restoring draft…' : 'Draft restored'}</span>}
      {orphanDrafts.length > 0 && <Menu>
        <MenuTrigger render={<Button className="handwork-draft-recovery-trigger" size="xs" variant="ghost" disabled={blocked || !sessionId} />}><History aria-hidden width={14} height={14} />{orphanDrafts.length} saved {orphanDrafts.length === 1 ? 'draft' : 'drafts'}</MenuTrigger>
        <MenuPopup side="top" align="start" className="handwork-draft-recovery-menu" aria-label="Saved unsent messages">
          {(draft || attachments.length > 0) && <p className="handwork-draft-recovery-hint">Clear your message or open a new chat to restore another draft.</p>}
          {orphanDrafts.map(entry => <MenuItem key={entry.id} className="handwork-draft-recovery-item" disabled={!!draft || attachments.length > 0} onClick={() => void recoverDraft(entry)}><span>{entry.text.trim().slice(0, 80) || entry.files.map(file => file.name).join(', ').slice(0, 80) || 'Unsent message'}</span></MenuItem>)}
        </MenuPopup>
      </Menu>}
    </div>}
    {queue.length > 0 && !pendingChat && <HandworkQueue items={queue} paused={queuePaused} restored={restoredQueues.has(sessionId)} busy={busy}
      onResume={() => resumeQueue(sessionId)}
      onSendNow={() => resumeQueue(sessionId)}
      onEdit={item => {
        editQueue(sessionId, items => items.filter(entry => entry.id !== item.id));
        setDraft(current => current.trim() ? `${current.trimEnd()}\n\n${item.text}` : item.text);
        stageFiles(item.files);
        focusComposer();
      }}
      onRemove={item => editQueue(sessionId, items => items.filter(entry => entry.id !== item.id))}
      onClear={() => {
        const target = sessionId; const removed = queue;
        editQueue(target, () => []);
        const message = `Removed ${removed.length} queued message${removed.length === 1 ? "" : "s"}.`;
        setNotice(message);
        setNoticeAction({ notice: message, label: "Undo", run: () => { editQueue(target, items => [...removed, ...items.filter(item => !removed.some(entry => entry.id === item.id))]); setPausedQueues(current => new Set(current).add(target)); } });
      }} />}
    {viewedChat?.archived && <div className="handwork-archived-banner" role="status"><Archive aria-hidden width={14} height={14} /><span>This chat is archived. Sending a message restores it.</span><Button size="xs" variant="outline" onClick={() => void archiveChat(viewedChat, false)}><ArchiveRestore aria-hidden width={12} height={12} />Restore</Button></div>}
    <PromptBar sendKey={preferences?.app.sendKey} value={draft} onValueChange={setDraft} hasExternalAttachments={attachments.length > 0} placeholder={busy && !pendingChat ? "Queue a follow-up…" : conversation.entries.length ? "Reply to Handwork…" : workspaceName ? `Ask about ${workspaceName}…` : "Ask Handwork…"}
      onQueue={busy && !pendingChat ? ({ text: queued }) => {
        dictation.cancel();
        const target = sessionId;
        editQueue(target, items => [...items, { id: crypto.randomUUID(), text: queued, files: attachments, queuedAt: Date.now() }]);
        setAttachments([]); setRejectedFiles([]);
      } : undefined}
      disabled={unavailable || working || picking || navigating || recoveringDraft} onStop={busy && !pendingChat ? () => void cancel() : undefined}
      commands={[...slashItems, ...prompts.map(prompt => ({ id: `prompt:${prompt.id}`, label: promptSlug(prompt), description: prompt.title, icon: <BookText /> }))]}
      onItemSelect={item => {
        const prompt = item.id.startsWith("prompt:") ? prompts.find(entry => `prompt:${entry.id}` === item.id) : undefined;
        if (!prompt) {
          // A menu selection is an action, not text that needs another press of Send.
          if (!/^\/[\w-]*$/.test(draft.trim())) return;
          setDraft('');
          void runCommand(item.label, '').catch(cause => setError(String(cause)));
          return;
        }
        // Swap the typed /name for the prompt itself.
        const token = `/${item.label} `;
        setDraft(current => { const index = current.lastIndexOf(token); return index < 0 ? current : current.slice(0, index) + current.slice(index + token.length); });
        usePrompt(prompt);
      }}
      onPaste={event => {
        if (blocked) return;
        const files = Array.from(event.clipboardData.files);
        if (!files.length) return;
        event.preventDefault();
        void stageDroppedFiles(files).catch(cause => setError(String(cause)));
      }}
      onSubmit={({ text }) => {
        dictation.cancel();
        const command = attachments.length ? null : parseSlashCommand(text);
        if (command) { void runCommand(command.name, command.args).catch(cause => { setError(String(cause)); setDraft(current => current || text); }); return; }
        const target = sessionId;
        void send(text).catch(() => { if (activeSession.current === target) setDraft(current => current || text); });
      }}
      attachmentPreview={(attachments.length > 0 || rejectedFiles.length > 0) && <HandworkAttachmentTray files={attachments} rejected={rejectedFiles} onRemove={index => setAttachments(current => current.filter((_, i) => i !== index))} onDismissRejected={() => setRejectedFiles([])} />}
      leadingActions={<Menu>
        <MenuTrigger render={<Button className="handwork-attach" size="icon" variant="ghost" aria-label="Add files, screenshots, and prompts" title="Add files, screenshots, and prompts" disabled={!api || blocked || capturing} />}><IconPlus size={18} /></MenuTrigger>
        <MenuPopup side="top" align="start" sideOffset={10} className="handwork-composer-menu" aria-label="Add to message">
          <MenuItem onClick={() => void addFiles()}><Paperclip aria-hidden />Attach files…</MenuItem>
          <MenuItem disabled={!api?.captureScreen || attachments.length >= 10} onClick={() => void captureScreenshot()}><SquareDashedMousePointer aria-hidden />Take screenshot</MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => setLibrary({ open: true })}><BookText aria-hidden />Saved prompts…<MenuShortcut>/</MenuShortcut></MenuItem>
          <MenuItem disabled={!draft.trim()} onClick={() => setLibrary({ open: true, draft })}><Bookmark aria-hidden />Save as prompt…</MenuItem>
        </MenuPopup>
      </Menu>}
      actions={<>
        <ComposerOptions options={composerOptions} disabled={busy || working || picking || navigating || unavailable} syncing={configuring} onChange={(id, value) => void configure(id, value)}
          shortcuts={shortcuts} onChooseModel={model => void chooseModel(model)} onFavorite={api?.setModelFavorite ? favorite => void favoriteModel(favorite) : undefined} />
        {dictation.status.available && <>
          <Button size="icon-sm" variant="ghost" aria-label={dictation.phase === 'recording' ? "Stop dictation" : dictation.phase === 'transcribing' ? "Transcribing…" : "Dictate offline"} title={dictation.phase === 'recording' ? "Stop dictation (maximum 2 minutes)" : "Dictate offline · English"} aria-pressed={dictation.phase === 'recording'} disabled={unavailable || blocked || dictation.phase === 'starting' || dictation.phase === 'transcribing'} onClick={() => void dictation.toggle()}><IconMic size={16} /></Button>
          {dictation.phase !== 'idle' && <span role="status">{dictation.phase === 'starting' ? 'Opening microphone…' : dictation.phase === 'recording' ? 'Listening…' : 'Transcribing…'}</span>}
          {dictation.phase !== 'idle' && <Button size="icon-sm" variant="ghost" aria-label="Cancel dictation" title="Cancel dictation" onClick={dictation.cancel}><IconClose size={14} /></Button>}
        </>}
      </>} />
  </div>;
  return <main className={`handwork-app ${desktopWindows ? 'handwork-windows' : ''} ${desktopMac ? "handwork-mac" : ""}`}>
    {desktopMac && <div aria-hidden className="app-drag handwork-titlebar" />}
    {desktopWindows && api && <HandworkWindowControls api={api} maximized={maximized} onState={state => { setFullscreen(state.fullscreen); setMaximized(state.maximized); }} />}
    <Dialog open={!!projectToDelete} onOpenChange={open => { if (!open && !deletingProject) setProjectToDelete(undefined); }}>
      <DialogPopup className="handwork-chat-dialog" showCloseButton={!deletingProject} initialFocus={() => document.getElementById("handwork-project-cancel")} finalFocus={() => document.querySelector<HTMLTextAreaElement>('[data-slot="prompt-bar-input"]')}>
        <form onSubmit={event => { event.preventDefault(); void deleteProject(); }}>
          <DialogHeader><DialogTitle>Delete project?</DialogTitle><DialogDescription>Remove "{projectToDelete?.split('/').filter(Boolean).pop()}" from Projects? Files on disk and chats will not be deleted. You can add the folder again later.</DialogDescription></DialogHeader>
          {projectDeleteError && <p role="alert" className="handwork-chat-action-error">{projectDeleteError}</p>}
          <DialogFooter><Button id="handwork-project-cancel" type="button" variant="ghost" disabled={deletingProject} onClick={() => setProjectToDelete(undefined)}>Cancel</Button><Button type="submit" variant="destructive" disabled={deletingProject}>{deletingProject ? "Deleting…" : "Delete project"}</Button></DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
    <Dialog open={!!chatAction} onOpenChange={open => { if (!open && !savingChat) setChatAction(undefined); }}>
      <DialogPopup className="handwork-chat-dialog" showCloseButton={!savingChat} initialFocus={() => document.getElementById(chatAction?.kind === "rename" ? "handwork-chat-name" : "handwork-chat-cancel")} finalFocus={() => document.querySelector<HTMLTextAreaElement>('[data-slot="prompt-bar-input"]')}>
        <form onSubmit={event => { event.preventDefault(); void saveChatAction(); }}>
          <DialogHeader><DialogTitle>{chatAction?.kind === "rename" ? "Rename chat" : "Delete chat?"}</DialogTitle><DialogDescription>{chatAction?.kind === "rename" ? "Choose a name you’ll recognize in your sidebar." : `“${chatAction?.chat.label ?? ""}” will be permanently deleted. This cannot be undone.`}</DialogDescription></DialogHeader>
          {chatAction?.kind === "rename" && <DialogBody><label htmlFor="handwork-chat-name">Chat name</label><Input id="handwork-chat-name" value={chatName} onChange={event => setChatName(event.target.value)} maxLength={200} required disabled={savingChat} /></DialogBody>}
          {chatActionError && <p role="alert" className="handwork-chat-action-error">{chatActionError}</p>}
          <DialogFooter><Button id="handwork-chat-cancel" type="button" variant="ghost" disabled={savingChat} onClick={() => setChatAction(undefined)}>Cancel</Button><Button type="submit" variant={chatAction?.kind === "delete" ? "destructive" : "default"} disabled={savingChat || (chatAction?.kind === "rename" && !chatName.trim())}>{savingChat ? "Saving…" : chatAction?.kind === "rename" ? "Save" : "Delete"}</Button></DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
    <HandworkCommandPalette open={paletteOpen} initialPage={palettePage} onOpenChange={open => { setPaletteOpen(open); if (!open) setPalettePage(''); }} api={api} chats={chatRows} projects={projects} prompts={prompts} actions={paletteActions} pages={palettePages}
      models={shortcuts} onChooseModel={model => void chooseModel(model)}
      onOpenChat={(chat, query) => { openChat(chat); if (query) openFind(query); }} onNewProjectChat={project => { if (!blocked) void sessionAction("project", project); }}
      onUsePrompt={usePrompt} onChoose={(id, value) => { if (id === "theme") void chooseTheme(value as "system" | "light" | "dark"); else void configure(id, value); }} />
    <HandworkPromptLibrary open={library.open} newDraft={library.draft} onOpenChange={open => setLibrary({ open })} api={api} prompts={prompts} onPromptsChange={setPrompts} onUse={usePrompt} />
    <PromptFillDialog prompt={fillingPrompt} onCancel={() => setFillingPrompt(undefined)} onInsert={insertPrompt} />
    <HandworkFileViewer file={viewingFile} api={api} onClose={() => setViewingFile(undefined)} />
    <HandworkCommandReport command={reportCommand} api={api} onClose={() => setReportCommand(undefined)} />
    <HandworkChatDetails open={detailsOpen} onOpenChange={setDetailsOpen} api={api} title={activeChat?.label || conversation.title || "New chat"} chatId={sessionId || undefined} options={options} conversation={withSavedUsage(conversation, chatPreferences[sessionId]?.usage)} onOpenSettings={() => setSettingsOpen(true)} onOpenFile={setViewingFile} />
    <HandworkShortcuts open={shortcutsOpen} onOpenChange={setShortcutsOpen} preferences={preferences?.app} desktop={!!api} />
    <SidebarNav collapsed={narrowSidebar ? !narrowSidebarOpen : undefined} onCollapsedChange={collapsed => { if (narrowSidebar) setNarrowSidebarOpen(!collapsed); }} collapsedFooter={<div className="handwork-sidebar-footer-stack"><HandworkUpdate api={api} busy={busy || working || configuring || !!busyProvider} compact prepareRestart={prepareUpdateRestart} /><Button variant="ghost" size="icon-sm" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}><IconSettings size={16} /></Button></div>} className="handwork-sidebar" header={<div className="handwork-sidebar-heading"><h1 data-slot="handwork-brand" className="handwork-brand">Handwork</h1></div>}
      items={[{ id: 'search', label: 'Search chats', icon: <Search aria-hidden width={16} height={16} /> }]} onNavigate={() => setPaletteOpen(true)} threads={[]} onThreadSelect={() => {}}
      onNewChat={() => { if (!blocked && api) void sessionAction(workspace ? 'project' : 'chat', workspace || undefined); }}
      content={<HandworkSidebarContent attention={attentionKinds} projects={projects} sessions={chatRows} activeSession={shownSession} runningSession={sessionId} runningSessions={runningSessions} unreadSessions={unreadSessions} queuedSessions={queuedCounts} busy={busy} connecting={working || navigating} disabled={blocked || !api} chatDisabled={picking || !api}
        onDismissIssue={clearIssue} onDeleteProject={project => { setProjectToDelete(project); setProjectDeleteError(""); }}
        onAdd={openProject} onNewProjectChat={project => void sessionAction("project", project)} onChat={chat => { const item = attention.find(item => item.id === chat.id); if (item) openAttention(item); else openChat(chat); }} openSessions={tabs.map(tab => tab.id)} onClose={closeTab} onPin={chat => void pinChat(chat)} onArchive={(chat, archived) => void archiveChat(chat, archived)}
        onRename={chat => { setChatAction({ kind: "rename", chat }); setChatName(chat.label); setChatActionError(""); }} onDelete={chat => { setChatAction({ kind: "delete", chat }); setChatActionError(""); }} />}
      footer={<div className="handwork-sidebar-footer-stack"><HandworkUpdate api={api} busy={busy || working || configuring || !!busyProvider} prepareRestart={prepareUpdateRestart} /><div className="handwork-sidebar-footer"><Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}><IconSettings size={16} />Settings</Button><HandworkSubscriptionUsage api={api} active={providers.some(provider => provider.id === 'codex' && provider.connected)} compact /><HandworkTheme /></div></div>} />
    <section className="handwork-workspace" aria-label="Conversation workspace">
      <header className="handwork-header" aria-label="Conversation toolbar">
        <div className="handwork-current-chat">
          {workspace && <span className="handwork-current-project" title={workspace}>{workspace.split(/[\\/]/).filter(Boolean).pop()}</span>}
          <span className="handwork-current-title" title={pendingChat?.label || activeChat?.label || shownConversation.title || 'New chat'}>{pendingChat?.label || activeChat?.label || shownConversation.title || 'New chat'}</span>
        </div>
        <Button className="handwork-details-trigger" size="icon-sm" variant="ghost" aria-label="Chat details" title={`Chat details (${shortcutLabel("Mod+I")})`} aria-haspopup="dialog" disabled={!api || !sessionId || !!pendingChat} onClick={() => setDetailsOpen(true)}><Info aria-hidden width={15} height={15} /></Button>
        {showProjectTools && <div className="handwork-header-actions">
          <ChangesTrigger open={changesOpen} fileCount={projectChangeState.snapshot?.totalFiles ?? 0} added={changesComplete ? addedLines : undefined} removed={changesComplete ? removedLines : undefined} onClick={() => { setChangesOpen(value => !value); setActivityOpen(false); }} />
          <Button id="handwork-activity-trigger" size="xs" variant="ghost" aria-pressed={activityOpen} onClick={() => { setActivityOpen(value => !value); setChangesOpen(false); }}>Activity</Button>

        </div>}
      </header>
      {error && !(shownConversation.canContinue && failedPrompt?.session === sessionId && failedPrompt.error === error) && <div role="alert" className="handwork-notice" data-attention="error"><Badge variant="error">Error</Badge><span>{error.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}</span>{failedPrompt?.session === sessionId && failedPrompt.error === error && !busy && <Button className="handwork-notice-action" size="xs" variant="outline" disabled={blocked} onClick={() => void retryLast()}><RotateCcw aria-hidden width={12} height={12} />Try again</Button>}</div>}
      {!api && <p className="handwork-notice">Open the Electron app with npm run desktop:dev to use local Handwork. This browser preview cannot access your files or run commands.</p>}
      <div className="handwork-workspace-body">
      <HandworkConversation landing={landing} sessionKey={shownSession} busy={busy || working || !!pendingChat}
        overlay={<HandworkFindBar open={find.open && !landing} focusSignal={find.focus} query={find.query} sessionKey={shownSession} onQueryChange={query => setFind(current => ({ ...current, query }))} onClose={() => { setFind(current => ({ ...current, open: false })); focusComposer(); }} />}
        footer={<>{composer}{landing && workspace && sessionId && preferences?.effective.suggestions !== false && <div className="handwork-suggestions" aria-label="Suggested prompts">{projectSuggestions.map(({ label, prompt }) => <Button key={label} variant="ghost" size="sm" disabled={unavailable || blocked} onClick={() => {
        setDraft(prompt);
        requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-slot="prompt-bar-input"]')?.focus());
      }}><span>{label}</span></Button>)}
        {suggestionState.key === suggestionKey && suggestionState.status === "loading" && <span role="status" className="handwork-suggestion-status">Finding useful next steps…</span>}
        {suggestionState.key === suggestionKey && suggestionState.status === "failed" && <Button variant="ghost" size="sm" disabled={blocked} onClick={() => setSuggestionRetry(value => value + 1)}>Retry suggestions</Button>}
      </div>}</>}>
        {pendingChat && shownConversation.entries.length === 0 && <div className="handwork-opening"><h2>{pendingChat.label}</h2>{!busy && <LoadingState label="Opening chat…" />}</div>}
        {!pendingChat && conversation.entries.length === 0 && <div className="handwork-empty">
          <h2>{workspaceName ? <>What’s next for <HoverTooltip content={workspace}><span className="handwork-greeting-project" >{workspaceName}</span></HoverTooltip>?</> : "What can I help with?"}</h2>
          {!sessionId && <>{working ? <p role="status">{workspaceName ? "Connecting to your project…" : "Starting your chat…"}</p> : <><p>{workspaceName ? "Reconnect to continue working with your code." : "Ask a question or attach a file to get started."}</p><Button disabled={!api || blocked} variant="outline" size="sm" onClick={() => void sessionAction(workspace ? "connect" : "chat")}>{workspace ? "Reconnect" : "New chat"}</Button></>}</>}
        </div>}
        {(shownConversation.entries.length > 0 || shownConversation.recovery) && <HandworkTranscript entries={shownConversation.entries} busy={busy || working || !!pendingChat} onSend={send} onEdit={editMessage}
          recovery={shownConversation.recovery} canContinue={shownConversation.canContinue} onContinue={() => void continueResponse()} continuationDisabled={blocked || !api || !sessionId || !!pendingChat}
          onRetry={canRegenerate && !pendingChat && !blocked ? () => void retryLast() : undefined} versionFor={versionFor}
          workspace={showProjectTools ? workspace : undefined} onOpenFile={setViewingFile} onRevealFile={target => void api?.revealFile(target).catch(cause => setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")))} />}
        {(pendingChat ? [] : permissions).map(permission => <div key={permission.id} data-attention="approval"><ApprovalCard questions={[{ id: permission.id.toString(), prompt: `${permission.title}\n${permission.detail}`, type: "single", required: true, options: permission.options.map(option => ({ value: option.optionId, label: option.name })) }]}
          onSubmit={async answers => { const selected = answers[permission.id.toString()]?.selected[0]; if (selected && !answering) await answerPermission(permission.id, selected); }} /></div>)}
        {busy && !pendingChat && <div className="handwork-loading"><LoadingState label={permissions.length ? "Waiting for your approval" : "Handwork is working"} /></div>}
        {notice && <div role="status" className="handwork-notice" data-attention="notice"><span>{notice}</span>{noticeAction?.notice === notice && <Button className="handwork-notice-action" size="xs" variant="outline" disabled={blocked} onClick={() => { const action = noticeAction; setNotice(""); setNoticeAction(undefined); action.run(); }}>{noticeAction.label}</Button>}</div>}
      </HandworkConversation>
      {(showProjectTools || activityRequested) && (changesOpen || activityOpen && (tools.length > 0 || activityRequested)) && <aside id="handwork-review-panel" ref={reviewPanel} tabIndex={-1} className="handwork-review-panel" data-panel={changesOpen ? "changes" : "activity"} data-sized={reviewWidth ? "" : undefined} style={reviewWidth ? { "--handwork-review-width": `${reviewWidth}px` } as CSSProperties : undefined} aria-label={changesOpen ? "Changes" : "Activity"} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeReviewPanel(); } }}>
        <ResizeHandle className="handwork-review-resize" orientation="vertical" direction={-1} label="Resize panel" min={300}
          max={() => (reviewPanel.current?.parentElement?.clientWidth ?? 1200) - 360}
          measure={() => reviewPanel.current?.getBoundingClientRect().width} onResize={setReviewWidth} />
        <div className="handwork-panel-header"><h2>{changesOpen ? "Source control" : "Activity"}</h2><div className="handwork-panel-actions">{changesOpen && !!workspace && <Button size="icon-sm" variant="link" aria-label="Refresh project changes" title="Refresh project changes" disabled={projectChangeState.loading} onClick={projectChangeState.refresh}><RefreshCw size={14} aria-hidden /></Button>}<Button size="icon-sm" variant="ghost" aria-label="Close panel" title="Close panel (Escape)" onClick={closeReviewPanel}><IconClose size={16} /></Button></div></div>
        <div className="handwork-panel-content">{changesOpen ? <HandworkChanges modelLabel={currentModel ? modelDisplayName(currentModel.options.find(choice => choice.value === currentModel.currentValue)?.name ?? currentModel.currentValue) : undefined} modelPending={configuring || navigating} onWrite={api ? async () => { await configTail.current; return api.gitCommitMessage(workspace); } : undefined} key={workspace} api={api} workspace={workspace} snapshot={projectChangeState.snapshot} loading={projectChangeState.loading} error={projectChangeState.error} onChanged={projectChangeState.refresh} /> : <HandworkActivity entries={shownConversation.entries} workspaceName={workspaceName} used={shownUsage.used} capacity={shownUsage.capacity} />}</div>
      </aside>}
      </div>
    </section>
    <SettingsModal initialSection={settingsSection} api={api} preferences={preferences} onPreferences={receivePreferences} workspace={workspace} busy={busy || working || configuring} hasMessages={conversation.entries.length > 0} onReconnect={async () => {
      const previous = activeSession.current;
      await sessionAction('connect', workspace);
      if (!activeSession.current) throw new Error('Could not reconnect. Try opening the project again.');
      const temporary = activeSession.current;
      if (previous && conversation.entries.length) { await sessionAction('load', previous); if (activeSession.current === previous) setTabs(current => current.filter(tab => tab.id !== temporary)); }
    }} open={settingsOpen} onClose={() => { setSettingsOpen(false); setSettingsSection(undefined); }} providers={providers} providersReady={providersReady} busyProvider={busyProvider} error={providerError}
      onConnect={(id, key) => providerAction("connect", id, key)} onSignIn={id => providerAction("signIn", id)} onDisconnect={id => providerAction("disconnect", id)} onUse={id => void useProvider(id)} currentProvider={provider?.currentValue} onShowShortcuts={() => setShortcutsOpen(true)} onRestored={result => void afterRestore(result)} />
  </main>;
}
