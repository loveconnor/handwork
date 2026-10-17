"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import HandworkChanges, { ChangesTrigger } from '@/components/site/HandworkChanges';
import { useProjectChanges } from '@/lib/use-project-changes';
import { SidebarNav } from "@/components/ui/sidebar-nav";
import { PromptBar } from "@/components/ui/prompt-bar";
import { LoadingState } from "honestui/ai/loading-state";
import { HandworkConversation } from "@/components/site/HandworkConversation";
import { ApprovalCard } from "honestui/ai/approval-card";
import HandworkTranscript from "@/components/site/HandworkTranscript";
import { Button } from "@/components/ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { IconFileText, IconSettings, IconMic, IconPlus, IconClose } from "@/components/atoms/Icons";
import { ComposerOptions, HandworkTheme, chooseTheme } from "@/components/site/HandworkControls";
import type { SettingsSnapshot, Attachment, DesktopAPI, SessionResult, VoiceStatus, ProjectSuggestion, ChatPreference, SavedPrompt } from "@/lib/desktop-api";
import { applyUpdate, availableCommands, configOptions, emptyConversation, permissionFromEvent, providerList, record, text, type Command, type ConfigOption, type Conversation, type Entry, type Permission, type ProviderInfo } from "@/lib/desktop-state";
import { HandworkSidebarContent } from "@/components/site/HandworkSidebarContent";
import { HandworkCommandPalette, type PaletteAction, type PaletteChoicePage } from "@/components/site/HandworkCommandPalette";
import { HandworkFindBar } from "@/components/site/HandworkFindBar";
import { HandworkPromptLibrary, PromptFillDialog } from "@/components/site/HandworkPromptLibrary";
import { HandworkFileViewer, type FileTarget } from "@/components/site/HandworkFileViewer";
import { HandworkQueue, type QueuedMessage } from "@/components/site/HandworkQueue";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator, MenuShortcut } from "@/components/ui/menu";
import { Search, RefreshCw, RotateCcw, SquarePen, FolderPlus, TextSearch, BookText, Bookmark, SquareDashedMousePointer, Paperclip, Settings as SettingsIcon, Download, Activity, GitCompare, Pencil, Cpu, Plug, Gauge, Shield, SunMoon } from "honestui/icons";
import { isMac, promptSlug, promptVariables, shortcutLabel } from "@/lib/saved-prompts";
import { applyAppearance } from "@/lib/appearance";
import SettingsModal from "@/components/site/SettingsModal";
import { ResizeHandle, useStoredSize } from "@/components/site/HandworkResizeHandle";
import HandworkActivity from "@/components/site/HandworkActivity";
import HandworkUpdate from "@/components/site/HandworkUpdate";

type SavedSession = { id: string; label: string; workspace?: string; updatedAt?: string; turns?: number; pinned?: boolean };

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

/** What a saved draft contains, to skip saving when nothing changed. */
function draftKey(text: string, files: Attachment[]): string {
  return `${text}\u0000${files.map(file => `${file.name}:${file.size}:${(file.data ?? file.text ?? "").length}`).join("|")}`;
}

/** Untitled chats are told apart by when they were last touched. */
function untitledLabel(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "Untitled chat";
  const sameDay = date.toDateString() === new Date().toDateString();
  return `Chat · ${sameDay ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
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
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const [pausedQueues, setPausedQueues] = useState<Set<string>>(new Set());
  const [chatRequest, setChatRequest] = useState<string>();
  const savedDrafts = useRef(new Map<string, string>());
  const pendingDraft = useRef<{ id: string; text: string; files: Attachment[] | null; key: string }>(undefined);
  const restoredDraft = useRef<{ text: string; files: Attachment[] }>(undefined);
  // Actions stored with a notice run against the newest chat state, not the state when they were created.
  const latest = useRef<{ retryLast: () => Promise<void>; openChat: (chat: SavedSession) => void }>({ retryLast: async () => {}, openChat: () => {} });
  const activeWorkspace = useRef("");
  const [sessions, setSessions] = useState<SavedSession[]>(initialSidebar.sessions);
  const [tabs, setTabs] = useState<SavedSession[]>([]);
  const [options, setOptions] = useState<ConfigOption[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [chatPreferences, setChatPreferences] = useState<Record<string, ChatPreference>>({});
  const [chatAction, setChatAction] = useState<{ kind: "rename" | "delete"; chat: SavedSession }>();
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
  const [voice, setVoice] = useState<VoiceStatus>({ available: false });
  const [listening, setListening] = useState(false);
  const [narrowSidebar, setNarrowSidebar] = useState(false);
  const [narrowSidebarOpen, setNarrowSidebarOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersReady, setProvidersReady] = useState(false);
  const [busyProvider, setBusyProvider] = useState("");
  const [providerError, setProviderError] = useState("");
  const [activityOpen, setActivityOpen] = useState(true);
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
    bridge.voiceStatus().then(status => setVoice(status)).catch(() => setVoice({ available: false }));
    bridge.listPrompts?.().then(setPrompts).catch(cause => setNotice(cause instanceof Error ? cause.message : String(cause)));
    let mounted = true;
    void Promise.all([bridge.listProjects(), bridge.getSettings?.(), bridge.getStartup?.(), bridge.getUpdateDrafts?.().catch(() => { setNotice('Saved update drafts could not be restored.'); return []; }), bridge.listDrafts?.().catch(() => [])]).then(async ([paths, saved, startup, updateDrafts, savedDraftList]) => {
      if (!mounted) return;
      // Unsent drafts come back to their chats. A draft for a chat that was never
      // sent to (and so was discarded) returns to the first chat that opens.
      const known = new Set([...(startup?.tabs ?? []).map(tab => tab.id), ...initialSidebar.sessions.map(session => session.id)]);
      const orphans: string[] = [];
      for (const entry of savedDraftList ?? []) {
        savedDrafts.current.set(entry.id, draftKey(entry.text, entry.files));
        if (known.has(entry.id)) drafts.current.set(entry.id, { text: entry.text, files: entry.files });
        else { orphans.push(entry.id); restoredDraft.current ??= { text: entry.text, files: entry.files }; }
      }
      if (orphans.length) void bridge.removeDrafts?.(orphans).catch(() => {});
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
      if (event.method === 'desktop/open-chat') { setChatRequest(text(params.sessionId)); return; }
      if (event.method === 'desktop/quick-prompt') { setQuickPrompt({ text: text(params.text), attachments: Array.isArray(params.attachments) ? params.attachments as Attachment[] : [] }); return; }
      if (event.method === "desktop/notice") { setNotice(text(params.message)); return; }
      if (event.method === "window/state") { setFullscreen(params.fullscreen === true); return; }
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
        } else if (event.method === 'session/request_permission') {
          const permission = permissionFromEvent(record(event));
          if (permission) permissionCache.current.set(eventSession, [...(permissionCache.current.get(eventSession) ?? []).filter(p => p.id !== permission.id), permission]);
          setUnreadSessions(current => new Set(current).add(eventSession));
        } else if (event.method === 'engine/permissions_cleared') permissionCache.current.delete(eventSession);
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

  useEffect(() => {
    if (!sessionId) return;
    setTabs(current => current.map(tab => tab.id === sessionId ? { ...tab, label: conversation.title } : tab));
  }, [conversation.title, sessionId]);
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
      return { workspace: typeof session.cwd === 'string' ? session.cwd : workspace, id: text(session.sessionId), label: text(session.title) || (updatedAt ? untitledLabel(updatedAt) : "Untitled chat"), updatedAt, turns, pinned: session.pinned === true };
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
  function acceptSession(result: SessionResult) {
    activeSession.current = result.sessionId;
    setSessionId(result.sessionId);
    const next = configOptions(result.configOptions);
    rememberOptions(next); setOptions(next);
    setTabs(current => current.some(tab => tab.id === result.sessionId) ? current : [...current, { id: result.sessionId, label: "New chat", workspace: activeWorkspace.current }]);
  }
  async function sessionAction(action: "open" | "connect" | "new" | "load" | "chat" | "project", id?: string) {
    if (configPending.current) await configTail.current;
    if (!api || lock.current) return;
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
      setDraft(savedDraft?.text ?? ''); setAttachments(savedDraft?.files ?? []);
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
      acceptSession(result);
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
  const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
  /** Dropped files retain their bytes; the backend prepares native file targets. */
  async function stageDroppedFiles(files: File[]) {
    setError("");
    const staged: Attachment[] = [];
    for (const file of files.slice(0, 10)) {
      if (file.size > MAX_ATTACHMENT_BYTES) { setError(`${file.name} is larger than 5 MB`); continue; }
      const url = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      staged.push({ name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, data: url.slice(url.indexOf(",") + 1) });
    }
    setAttachments(current => [...current, ...staged].slice(0, 10));
  }
  async function addFiles() {
    if (!api) return;
    try { const picked = await api.chooseFiles(); setAttachments(current => [...current, ...picked].slice(0, 10)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function toggleVoice() {
    if (!api) return;
    try { if (listening) await api.stopVoice(); else await api.startVoice(); setListening(value => !value); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function send(prompt: string, filesOverride?: Attachment[]) {
    const promptSession = activeSession.current;
    if (!api || !promptSession || lock.current || running.current.has(promptSession)) throw new Error("Wait for your chat to be ready.");
    const pendingSettings = configPending.current ? configTail.current : undefined;
    const promptOperation = ++operation.current;
    markChatRead(promptSession);
    const localId = `local-${promptOperation}`;
    const files = filesOverride ?? attachments;
    running.current.add(promptSession); setRunningSessions(new Set(running.current));
    setError(""); setNotice(""); setFailedPrompt(current => current?.session === promptSession ? undefined : current);
    const shownFiles = files.map(file => ({ name: file.name, mimeType: file.mimeType, size: file.size, data: file.mimeType.startsWith("image/") ? file.data : undefined, uri: file.uri?.startsWith("file:") ? file.uri : undefined }));
    setConversation(current => ({ ...current, recovery: undefined, entries: [...current.entries, { id: localId, kind: "user", text: prompt, attachments: shownFiles }] }));
    setAttachments([]);
    let dispatched = false;
    try {
      if (pendingSettings && !await pendingSettings) throw new Error("The setting change failed. Choose a provider and try again.");
      if (promptOperation !== operation.current && activeSession.current === promptSession) {
        setConversation(current => ({ ...current, entries: current.entries.filter(entry => entry.id !== localId) }));
        setDraft(prompt); setAttachments(files);
        return;
      }
      dispatched = true;
      const result = record(await api.prompt(prompt, files, promptSession));
      const reason = text(result.stopReason);
      if (reason === 'end_turn' && activeSession.current !== promptSession) {
        setUnreadSessions(current => new Set(current).add(promptSession));
      }
      if (activeSession.current === promptSession && reason && reason !== "end_turn" && reason !== "cancelled") {
        const message = `Response ended early: ${reason.replaceAll("_", " ")}.`;
        setNotice(message);
        setNoticeAction({ notice: message, label: "Try again", run: () => void latest.current.retryLast() });
      }
    } catch (cause) {
      if (!dispatched) setConversation(current => ({ ...current, entries: current.entries.filter(entry => entry.id !== localId) }));
      if (activeSession.current === promptSession) {
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
      if (shot) { setAttachments(current => [...current, shot].slice(0, 10)); focusComposer(); }
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
  const openFind = (query?: string) => setFind(current => ({ open: true, query: query ?? current.query, focus: current.focus + 1 }));
  /** Edit and Try again both branch the chat: the earlier version stays as its own chat. */
  async function regenerate(id: string, editedText: string, reason: "edit" | "retry") {
    if (!api || lock.current || busy || !sessionId) throw new Error("Wait for the current response to finish before editing.");
    const users = conversation.entries.filter(entry => entry.kind === "user");
    const index = users.findIndex(entry => entry.id === id);
    if (index < 0) throw new Error("This message is no longer in the active chat.");
    const previous = conversation;
    const oldSession = sessionId;
    const oldChat = { id: oldSession, label: chatPreferences[oldSession]?.title || conversation.title || "Previous version", workspace: activeWorkspace.current };
    lock.current = true;
    setWorking(true); setError(""); setPermissions([]);
    activeSession.current = "";
    setConversation(emptyConversation());
    try {
      const result = await api.rewindSession(index, users[index].rawText ?? users[index].text);
      setTabs(current => current.filter(tab => tab.id !== oldSession));
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
      const message = reason === "retry" ? "The previous reply is saved as a separate chat. File changes and commands it made remain." : "Previous version saved as a separate chat. Earlier file changes and commands remain.";
      setNotice(message);
      setNoticeAction({ notice: message, label: "Open previous version", run: () => latest.current.openChat(oldChat) });
    };
    await send(editedText, []).then(announce, cause => { announce(); throw cause; }).finally(() => setAttachments(stagedFiles));
  }
  const editMessage = (id: string, editedText: string) => regenerate(id, editedText, "edit");
  useEffect(() => { latest.current = { retryLast, openChat }; });
  const lastUserEntry = conversation.entries.findLast(entry => entry.kind === "user");
  // The engine regenerates text-only turns; attachments have to be sent again.
  const canRegenerate = !!lastUserEntry && !lastUserEntry.attachments?.length;
  async function retryLast() {
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
    if (queues[sessionId]?.length) setPausedQueues(current => new Set(current).add(sessionId));
    try { await api?.cancel(sessionId); setPermissions([]); }
    catch (cause) { setError(String(cause)); }
  }
  async function deleteSession(id: string) {
    if (!api || lock.current || running.current.has(id)) throw new Error("Handwork is busy. Try again when it finishes.");
    lock.current = true; setWorking(true); setError(""); setNotice("");
    try {
      await api.deleteSession(id);
      chatCache.current.delete(id);
      setTabs(current => current.filter(tab => tab.id !== id));
      setSessions(current => current.filter(session => session.id !== id));
      if (id === sessionId) {
        // The engine released the deleted session; continue in a fresh one.
        activeSession.current = ""; setSessionId(""); setConversation(emptyConversation()); setPermissions([]);
        activeWorkspace.current = ''; setWorkspace('');
        acceptSession(await api.newChat());
      }
      await refreshSessions(api);
    } finally { lock.current = false; setWorking(false); }
  }
  async function pinChat(chat: SavedSession) {
    if (!api || blocked) return;
    try {
      const preference = await api.updateChat(chat.id, { pinned: !chat.pinned });
      setChatPreferences(current => ({ ...current, [chat.id]: preference }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function saveChatAction() {
    if (!api || !chatAction || savingChat) return;
    setSavingChat(true); setChatActionError("");
    try {
      if (chatAction.kind === "delete") await deleteSession(chatAction.chat.id);
      else {
        const preference = await api.updateChat(chatAction.chat.id, { title: chatName.trim() });
        setChatPreferences(current => ({ ...current, [chatAction.chat.id]: preference }));
      }
      setChatAction(undefined);
    } catch (cause) { setChatActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSavingChat(false); }
  }
  /** Engine-advertised slash commands, fulfilled with the ACP surface the desktop already has. */
  async function runCommand(name: string, args: string) {
    const choose = (optionId: string, query: string) => {
      const option = options.find(item => item.id === optionId);
      if (!option) { setNotice(`No ${optionId} setting is available for this session.`); return; }
      if (!query) { setNotice("Choose a model in the session configuration below."); return; }
      const needle = query.toLowerCase();
      const match = option.options.find(choice => choice.value.toLowerCase() === needle || choice.name.toLowerCase() === needle)
        ?? option.options.find(choice => choice.value.toLowerCase().includes(needle) || choice.name.toLowerCase().includes(needle));
      if (!match) { setNotice(`No ${option.name || optionId} matches "${query}". Options: ${option.options.map(choice => choice.name).join(", ")}`); return; }
      void configure(option.id, match.value);
    };
    setNotice("");
    switch (name) {
      case "help": setNotice(`Commands: ${commands.map(command => `/${command.name}`).join("  ")}`); break;
      case "new": case "clear": await sessionAction("chat"); break;
      case "resume": setNotice("Pick a saved chat from the sidebar to resume it."); break;
      case "model": choose("model", args); break;
      case "reasoning": choose("effort", args); break;
      case "permissions": choose("mode", args); break;
      case "status": case "usage": case "context": setActivityOpen(true); break;
      case "settings": setSettingsOpen(true); break;
      default: setNotice(`/${name} is not available in the desktop app yet.`);
    }
  }
  async function configure(id: string, value: string) {
    if (!api || lock.current || busy) return;
    const version = ++configVersion.current;
    configPending.current = true; setConfiguring(true); setError("");
    setOptions(current => {
      if (id !== 'provider') return current.map(option => option.id === id ? { ...option, currentValue: value } : option);
      const dependent = new Set(['model', 'effort', 'fast_mode']);
      const cached = providerOptions.current.get(value) ?? [];
      return [...current.filter(option => !dependent.has(option.id)).map(option => option.id === id ? { ...option, currentValue: value } : option), ...cached.filter(option => dependent.has(option.id))];
    });
    // Keep engine requests in order; only the latest choice may update the UI.
    const next = configTail.current.then(async () => {
      try {
        const result = configOptions(record(await api.setConfig(id, value)).configOptions);
        rememberOptions(result);
        if (version === configVersion.current) setOptions(result);
        return true;
      } catch (cause) {
        if (version === configVersion.current) {
          setOptions(confirmedOptions.current);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        return false;
      }
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
  const showProjectTools = !!workspace && (!pendingChat || pendingChat.workspace === workspace);
  const unavailable = !api || !sessionId || !!pendingChat;
  const blocked = working || configuring || picking || navigating || !!pendingChat;
  const tools = shownConversation.entries.filter(entry => entry.kind === "tool");
  const projectChangeState = useProjectChanges(api, workspace);
  const changes = projectChangeState.snapshot?.files ?? [];
  const changesComplete = !projectChangeState.snapshot?.truncated && changes.every(file => file.complete && !file.binary);
  const addedLines = changes.reduce((total, file) => total + file.added, 0);
  const removedLines = changes.reduce((total, file) => total + file.removed, 0);
  const closeReviewPanel = () => {
    document.getElementById(changesOpen ? 'handwork-changes-trigger' : 'handwork-activity-trigger')?.focus();
    setChangesOpen(false); setActivityOpen(false);
  };
  const provider = options.find(option => option.id === "provider");
  const openProject = () => void sessionAction("open");
  // Open tabs lead the list; a tab still titled "New chat" borrows the saved session's title.
  const recents: SavedSession[] = [
    ...tabs.map(tab => tab.label === "New chat" || tab.label === "Untitled session" ? { ...tab, label: sessions.find(session => session.id === tab.id)?.label ?? tab.label } : tab),
    ...sessions.filter(session => (!session.workspace || projects.includes(session.workspace)) && !tabs.some(tab => tab.id === session.id)),
  ].map(chat => ({ ...chat, label: chatPreferences[chat.id]?.title || chat.label, pinned: chatPreferences[chat.id]?.pinned ?? chat.pinned ?? false })).sort((a, b) => Number(b.pinned) - Number(a.pinned));
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
  // Drafts save shortly after typing stops, and immediately when the chat changes.
  const draftSession = sessionId && !pendingChat && !working ? sessionId : "";
  function flushDraft() {
    const pending = pendingDraft.current;
    pendingDraft.current = undefined;
    if (!pending || !api?.saveDraft) return;
    savedDrafts.current.set(pending.id, pending.key);
    void api.saveDraft(pending.id, pending.text, pending.files).catch(() => { savedDrafts.current.delete(pending.id); });
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
  // A draft whose chat no longer exists returns in the first empty composer.
  useEffect(() => {
    const restored = restoredDraft.current;
    if (!restored || !startupReady || !sessionId || working || draft || attachments.length) return;
    restoredDraft.current = undefined;
    setDraft(restored.text); setAttachments(restored.files);
    setNotice("Restored your unsent message.");
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
  // Queued follow-ups send one at a time once the current reply finishes.
  const queue = queues[sessionId] ?? [];
  const queuePaused = pausedQueues.has(sessionId);
  function dispatchQueued(next: QueuedMessage) {
    const target = sessionId;
    setQueues(current => ({ ...current, [target]: (current[target] ?? []).filter(item => item.id !== next.id) }));
    if (next.text.startsWith("/")) { const [name, ...args] = next.text.slice(1).split(/\s+/); void runCommand(name, args.join(" ")); return; }
    void send(next.text, next.files).catch(() => {
      // Keep the message and stop sending the rest until the person decides.
      setQueues(current => ({ ...current, [target]: [next, ...(current[target] ?? [])] }));
      setPausedQueues(current => new Set(current).add(target));
    });
  }
  useEffect(() => {
    if (!queue.length || queuePaused || !api || busy || blocked || lock.current) return;
    dispatchQueued(queue[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, queuePaused, api, busy, blocked]);
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
      if (event.repeat || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      // Dialogs keep their own keyboard behaviour.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]') && key !== 'f') return;
      if (key === 'f' && !document.querySelector('[role="dialog"]')) { event.preventDefault(); openFind(); }
      else if (key === 'n') { event.preventDefault(); if (!blocked && api) void sessionAction("chat"); }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  });
  // Inside the Electron shell on macOS the system title bar is hidden; leave room for the traffic lights.
  const desktopMac = !!api && !fullscreen && typeof navigator !== "undefined" && /Macintosh/.test(navigator.userAgent);

  const composerOptions = options.filter(option => workspace || option.id !== "mode").map(option => option.id === "provider" ? { ...option, options: option.options.filter(choice => choice.value === option.currentValue || providers.some(item => item.id === choice.value && item.connected)) } : option);
  const activeChat = recents.find(chat => chat.id === sessionId);
  const paletteActions: PaletteAction[] = [
    { id: "new-chat", label: "New chat", icon: <SquarePen aria-hidden />, shortcut: "Mod+N", keywords: "start conversation", disabled: blocked || !api, run: () => void sessionAction("chat") },
    { id: "open-project", label: "Open project…", icon: <FolderPlus aria-hidden />, keywords: "folder workspace add", disabled: blocked || !api, run: openProject },
    { id: "find", label: "Find in chat", icon: <TextSearch aria-hidden />, shortcut: "Mod+F", keywords: "search text conversation", disabled: !shownConversation.entries.length, run: () => openFind() },
    { id: "prompts", label: "Saved prompts", icon: <BookText aria-hidden />, keywords: "library snippets templates", disabled: !api, run: () => setLibrary({ open: true }) },
    ...(draft.trim() ? [{ id: "save-prompt", label: "Save draft as prompt", icon: <Bookmark aria-hidden />, keywords: "snippet template library", run: () => setLibrary({ open: true, draft }) }] : []),
    { id: "screenshot", label: "Take screenshot", icon: <SquareDashedMousePointer aria-hidden />, keywords: "capture screen window region image attach", disabled: !api?.captureScreen || blocked || capturing || attachments.length >= 10, run: () => void captureScreenshot() },
    { id: "attach", label: "Attach files…", icon: <Paperclip aria-hidden />, keywords: "upload file image", disabled: !api || blocked, run: () => void addFiles() },
    ...(activeChat && conversation.entries.length ? [{ id: "rename", label: "Rename chat…", icon: <Pencil aria-hidden />, keywords: "title", disabled: blocked, run: () => { setChatAction({ kind: "rename", chat: activeChat }); setChatName(activeChat.label); setChatActionError(""); } }] : []),
    { id: "export-markdown", label: "Export chat as Markdown", icon: <Download aria-hidden />, keywords: "save download share md document", disabled: !api || working || !conversation.entries.length, run: () => void exportChat("current", "markdown") },
    { id: "export-json", label: "Export chat as JSON", icon: <Download aria-hidden />, keywords: "save download backup data", disabled: !api || working || !conversation.entries.length, run: () => void exportChat("current", "json") },
    { id: "settings", label: "Settings", icon: <SettingsIcon aria-hidden />, shortcut: "Mod+,", keywords: "preferences options", run: () => setSettingsOpen(true) },
    ...(showProjectTools ? [
      { id: "activity", label: activityOpen ? "Hide activity" : "Show activity", icon: <Activity aria-hidden />, group: "view" as const, keywords: "tools panel", run: () => { setActivityOpen(value => !value); setChangesOpen(false); } },
      { id: "changes", label: changesOpen ? "Hide changes" : "Review changes", icon: <GitCompare aria-hidden />, group: "view" as const, keywords: "diff git files panel", run: () => { setChangesOpen(value => !value); setActivityOpen(false); } },
    ] : []),
  ];
  const pageIcons: Record<string, ReactNode> = { model: <Cpu aria-hidden />, provider: <Plug aria-hidden />, effort: <Gauge aria-hidden />, mode: <Shield aria-hidden /> };
  const pageLabels: Record<string, string> = { model: "Switch model", provider: "Switch provider", effort: "Reasoning effort", mode: "Session mode" };
  const palettePages: PaletteChoicePage[] = [
    ...composerOptions.filter(option => option.id in pageLabels && option.options.length > 1).map(option => ({ id: option.id, label: pageLabels[option.id], icon: pageIcons[option.id], option, disabled: busy || working || picking || navigating || unavailable })),
    { id: "theme", label: "Theme", icon: <SunMoon aria-hidden />, option: { id: "theme", name: "Theme", currentValue: preferences?.app.theme ?? "system", options: [{ value: "system", name: "System" }, { value: "light", name: "Light" }, { value: "dark", name: "Dark" }] } },
  ];

  const composer = <div className="handwork-composer" onDragOver={event => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={event => {
    event.preventDefault(); if (!blocked) void stageDroppedFiles(Array.from(event.dataTransfer.files)).catch(cause => setError(String(cause)));
  }}>
    {queue.length > 0 && <HandworkQueue items={queue} paused={queuePaused} busy={busy}
      onResume={() => setPausedQueues(current => { const next = new Set(current); next.delete(sessionId); return next; })}
      onSendNow={item => { setPausedQueues(current => { const next = new Set(current); next.delete(sessionId); return next; }); if (!busy && !blocked) dispatchQueued(item); }}
      onEdit={item => {
        setQueues(current => ({ ...current, [sessionId]: (current[sessionId] ?? []).filter(entry => entry.id !== item.id) }));
        setDraft(current => current.trim() ? `${current.trimEnd()}\n\n${item.text}` : item.text);
        setAttachments(current => [...current, ...item.files].slice(0, 10));
        focusComposer();
      }}
      onRemove={item => setQueues(current => ({ ...current, [sessionId]: (current[sessionId] ?? []).filter(entry => entry.id !== item.id) }))} />}
    <PromptBar sendKey={preferences?.app.sendKey} value={draft} onValueChange={setDraft} hasExternalAttachments={attachments.length > 0} placeholder={busy && !pendingChat ? "Queue a follow-up…" : conversation.entries.length ? "Reply to Handwork…" : workspaceName ? `Ask about ${workspaceName}…` : "Ask Handwork…"}
      onQueue={busy && !pendingChat ? ({ text: queued }) => {
        const target = sessionId;
        setQueues(current => ({ ...current, [target]: [...(current[target] ?? []), { id: crypto.randomUUID(), text: queued, files: attachments }] }));
        setAttachments([]);
      } : undefined}
      disabled={unavailable || working || picking || navigating} onStop={busy && !pendingChat ? () => void cancel() : undefined}
      commands={[...commands.map(command => ({ id: command.name, label: command.name, description: command.description })), ...prompts.map(prompt => ({ id: `prompt:${prompt.id}`, label: promptSlug(prompt), description: prompt.title, icon: <BookText /> }))]}
      onItemSelect={item => {
        const prompt = item.id.startsWith("prompt:") ? prompts.find(entry => `prompt:${entry.id}` === item.id) : undefined;
        if (!prompt) return;
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
        if (text.startsWith("/")) { const [name, ...args] = text.slice(1).split(/\s+/); void runCommand(name, args.join(" ")); return; }
        const target = sessionId;
        void send(text).catch(() => { if (activeSession.current === target) setDraft(current => current || text); });
      }}
      attachmentPreview={attachments.length > 0 && <div className="handwork-attachments" aria-label="Attachments">{attachments.map((file, index) => <Button key={`${file.name}-${index}`} size="sm" variant="secondary" aria-label={`Remove ${file.name}`} onClick={() => setAttachments(current => current.filter((_, i) => i !== index))}>{file.data && file.mimeType.startsWith("image/") ? <img className="handwork-attachment-thumb" src={`data:${file.mimeType};base64,${file.data}`} alt="" /> : <IconFileText size={14} />}<span>{file.name}</span><IconClose size={12} /></Button>)}</div>}
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
        <ComposerOptions options={composerOptions} disabled={busy || working || picking || navigating || unavailable} syncing={configuring} onChange={(id, value) => void configure(id, value)} />
        {voice.available && <Button size="icon-sm" variant="ghost" aria-label={listening ? "Stop dictation" : "Dictate"} title={listening ? "Stop dictation" : "Dictate"} aria-pressed={listening} onClick={() => void toggleVoice()}><IconMic size={16} /></Button>}
      </>} />
  </div>;
  return <main className={`handwork-app ${desktopMac ? "handwork-mac" : ""}`}>
    {desktopMac && <div aria-hidden className="app-drag handwork-titlebar" />}
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
    <HandworkCommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} api={api} chats={recents} projects={projects} prompts={prompts} actions={paletteActions} pages={palettePages}
      onOpenChat={(chat, query) => { openChat(chat); if (query) openFind(query); }} onNewProjectChat={project => { if (!blocked) void sessionAction("project", project); }}
      onUsePrompt={usePrompt} onChoose={(id, value) => { if (id === "theme") void chooseTheme(value as "system" | "light" | "dark"); else void configure(id, value); }} />
    <HandworkPromptLibrary open={library.open} newDraft={library.draft} onOpenChange={open => setLibrary({ open })} api={api} prompts={prompts} onPromptsChange={setPrompts} onUse={usePrompt} />
    <PromptFillDialog prompt={fillingPrompt} onCancel={() => setFillingPrompt(undefined)} onInsert={insertPrompt} />
    <HandworkFileViewer file={viewingFile} api={api} onClose={() => setViewingFile(undefined)} />
    <SidebarNav collapsed={narrowSidebar ? !narrowSidebarOpen : undefined} onCollapsedChange={collapsed => { if (narrowSidebar) setNarrowSidebarOpen(!collapsed); }} collapsedFooter={<div className="handwork-sidebar-footer-stack"><HandworkUpdate api={api} busy={busy || working || configuring || !!busyProvider} compact prepareRestart={prepareUpdateRestart} /><Button variant="ghost" size="icon-sm" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}><IconSettings size={16} /></Button></div>} className="handwork-sidebar" header={<div className="handwork-sidebar-heading"><h1 data-slot="handwork-brand" className="handwork-brand">Handwork</h1><Button size="icon-sm" variant="ghost" aria-label="Search and commands" aria-haspopup="dialog" aria-expanded={paletteOpen} title={`Search and commands (${shortcutLabel("Mod+K")})`} onClick={() => setPaletteOpen(true)}><Search aria-hidden width={16} height={16} /></Button></div>}
      items={[]} onNavigate={() => {}} threads={[]} onThreadSelect={() => {}}
      onNewChat={() => { if (!blocked && api) void sessionAction("chat"); }}
      content={<HandworkSidebarContent projects={projects} sessions={recents} activeSession={shownSession} runningSession={sessionId} runningSessions={runningSessions} unreadSessions={unreadSessions} busy={busy} connecting={working || navigating} disabled={blocked || !api} chatDisabled={picking || !api}
        onAdd={openProject} onNewProjectChat={project => void sessionAction("project", project)} onChat={openChat} openSessions={tabs.map(tab => tab.id)} onClose={closeTab} onPin={chat => void pinChat(chat)}
        onRename={chat => { setChatAction({ kind: "rename", chat }); setChatName(chat.label); setChatActionError(""); }} onDelete={chat => { setChatAction({ kind: "delete", chat }); setChatActionError(""); }} />}
      footer={<div className="handwork-sidebar-footer-stack"><HandworkUpdate api={api} busy={busy || working || configuring || !!busyProvider} prepareRestart={prepareUpdateRestart} /><div className="handwork-sidebar-footer"><Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}><IconSettings size={16} />Settings</Button><HandworkTheme /></div></div>} />
    <section className="handwork-workspace" aria-label="Conversation workspace">
      <header className="handwork-header" aria-label="Conversation toolbar">
        <div className="handwork-tabs" aria-label="Open chats">
          {tabs.length ? tabs.map(tab => <div key={tab.id} className={`handwork-tab ${shownSession === tab.id ? "is-active" : ""}`}>
            <Button className="handwork-tab-label" variant="ghost" size="sm" disabled={picking} aria-pressed={shownSession === tab.id} title={chatPreferences[tab.id]?.title || tab.label} onClick={() => openChat({ ...tab, label: chatPreferences[tab.id]?.title || tab.label })}>{chatPreferences[tab.id]?.title || tab.label}</Button>
            <Button className="handwork-tab-close" variant="ghost" size="icon-sm" disabled={blocked} aria-label={`Close ${chatPreferences[tab.id]?.title || tab.label}`} onClick={() => closeTab(tab.id)}><IconClose size={12} /></Button>
          </div>) : <span className="handwork-title">Handwork</span>}
          <Button className="handwork-new-tab" size="icon-sm" variant="ghost" aria-label="New chat" title="New chat" disabled={blocked || !api} onClick={() => void sessionAction("chat")}><IconPlus size={15} /></Button>
        </div>
        {showProjectTools && <div className="handwork-header-actions">
          <ChangesTrigger open={changesOpen} fileCount={projectChangeState.snapshot?.totalFiles ?? 0} added={changesComplete ? addedLines : undefined} removed={changesComplete ? removedLines : undefined} onClick={() => { setChangesOpen(value => !value); setActivityOpen(false); }} />
          <Button id="handwork-activity-trigger" size="xs" variant="ghost" aria-pressed={activityOpen} onClick={() => { setActivityOpen(value => !value); setChangesOpen(false); }}>Activity</Button>

        </div>}
      </header>
      {error && <div role="alert" className="handwork-notice"><Badge variant="error">Error</Badge><span>{error.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}</span>{failedPrompt?.session === sessionId && failedPrompt.error === error && !busy && <Button className="handwork-notice-action" size="xs" variant="outline" disabled={blocked} onClick={() => void retryLast()}><RotateCcw aria-hidden width={12} height={12} />Try again</Button>}</div>}
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
          <h2>{workspaceName ? <>What’s next for <span className="handwork-greeting-project" title={workspace}>{workspaceName}</span>?</> : "What can I help with?"}</h2>
          {!sessionId && <>{working ? <p role="status">{workspaceName ? "Connecting to your project…" : "Starting your chat…"}</p> : <><p>{workspaceName ? "Reconnect to continue working with your code." : "Ask a question or attach a file to get started."}</p><Button disabled={!api || blocked} variant="outline" size="sm" onClick={() => void sessionAction(workspace ? "connect" : "chat")}>{workspace ? "Reconnect" : "New chat"}</Button></>}</>}
        </div>}
        {shownConversation.entries.length > 0 && <HandworkTranscript entries={shownConversation.entries} busy={busy || working || !!pendingChat} onSend={send} onEdit={editMessage}
          onRetry={canRegenerate && !pendingChat && !blocked ? () => void retryLast() : undefined}
          workspace={showProjectTools ? workspace : undefined} onOpenFile={setViewingFile} onRevealFile={target => void api?.revealFile(target).catch(cause => setError((cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "")))} />}
        {(pendingChat ? [] : permissions).map(permission => <ApprovalCard key={permission.id} questions={[{ id: permission.id.toString(), prompt: `${permission.title}\n${permission.detail}`, type: "single", required: true, options: permission.options.map(option => ({ value: option.optionId, label: option.name })) }]}
          onSubmit={async answers => { const selected = answers[permission.id.toString()]?.selected[0]; if (selected && !answering) await answerPermission(permission.id, selected); }} />)}
        {busy && !pendingChat && <div className="handwork-loading"><LoadingState label={permissions.length ? "Waiting for your approval" : "Handwork is working"} /></div>}
        {(notice || shownConversation.recovery) && <div role="status" className="handwork-notice"><span>{notice || shownConversation.recovery}</span>{notice && noticeAction?.notice === notice && <Button className="handwork-notice-action" size="xs" variant="outline" disabled={blocked} onClick={() => { const action = noticeAction; setNotice(""); setNoticeAction(undefined); action.run(); }}>{noticeAction.label}</Button>}</div>}
      </HandworkConversation>
      {showProjectTools && (changesOpen || activityOpen && tools.length > 0) && <aside id="handwork-review-panel" ref={reviewPanel} tabIndex={-1} className="handwork-review-panel" data-panel={changesOpen ? "changes" : "activity"} data-sized={reviewWidth ? "" : undefined} style={reviewWidth ? { "--handwork-review-width": `${reviewWidth}px` } as CSSProperties : undefined} aria-label={changesOpen ? "Changes" : "Activity"} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeReviewPanel(); } }}>
        <ResizeHandle className="handwork-review-resize" orientation="vertical" direction={-1} label="Resize panel" min={300}
          max={() => (reviewPanel.current?.parentElement?.clientWidth ?? 1200) - 360}
          measure={() => reviewPanel.current?.getBoundingClientRect().width} onResize={setReviewWidth} />
        <div className="handwork-panel-header"><h2>{changesOpen ? "Changes" : "Activity"}</h2><div className="handwork-panel-actions">{changesOpen && !!workspace && <Button size="icon-sm" variant="link" aria-label="Refresh project changes" title="Refresh project changes" disabled={projectChangeState.loading} onClick={projectChangeState.refresh}><RefreshCw size={14} aria-hidden /></Button>}<Button size="icon-sm" variant="ghost" aria-label="Close panel" title="Close panel (Escape)" onClick={closeReviewPanel}><IconClose size={16} /></Button></div></div>
        <div className="handwork-panel-content">{changesOpen ? <HandworkChanges key={workspace} api={api} workspace={workspace} snapshot={projectChangeState.snapshot} loading={projectChangeState.loading} error={projectChangeState.error} /> : <HandworkActivity entries={shownConversation.entries} workspaceName={workspaceName} used={shownConversation.used} capacity={shownConversation.capacity} />}</div>
      </aside>}
      </div>
    </section>
    <SettingsModal api={api} preferences={preferences} onPreferences={receivePreferences} workspace={workspace} busy={busy || working || configuring} hasMessages={conversation.entries.length > 0} onReconnect={async () => {
      const previous = activeSession.current;
      await sessionAction('connect', workspace);
      if (!activeSession.current) throw new Error('Could not reconnect. Try opening the project again.');
      const temporary = activeSession.current;
      if (previous && conversation.entries.length) { await sessionAction('load', previous); if (activeSession.current === previous) setTabs(current => current.filter(tab => tab.id !== temporary)); }
    }} open={settingsOpen} onClose={() => setSettingsOpen(false)} providers={providers} providersReady={providersReady} busyProvider={busyProvider} error={providerError}
      onConnect={(id, key) => providerAction("connect", id, key)} onSignIn={id => providerAction("signIn", id)} onDisconnect={id => providerAction("disconnect", id)} onUse={id => void useProvider(id)} currentProvider={provider?.currentValue} />
  </main>;
}
