import type { ChatBranch } from './chat-versions';
export type DesktopPreferences = {
  theme: 'system' | 'light' | 'dark'; uiFontSize: number; codeFontSize: number;
  sendKey: 'enter' | 'modifier-enter'; restoreChats: boolean; preferredEditor: 'system' | 'vscode' | 'cursor' | 'zed';
  defaultProvider: string; defaultModel: string; defaultMode: 'ask' | 'code'; suggestions: boolean;
  notifyComplete: boolean; notifyApproval: boolean; notifyError: boolean; notificationSound: boolean; notificationsBackgroundOnly: boolean;
  quickEntryShortcut: QuickEntryShortcut;
  /** Closing the window hides it; only Quit stops Handwork. */
  keepRunning: boolean;
};
export type QuickEntryShortcut = 'off' | 'Alt+Space' | 'Control+Alt+Space' | 'CommandOrControl+Shift+Space';
export type SavedPrompt = { id: string; title: string; folder: string; text: string; createdAt: number; updatedAt: number };
export type SavedPromptInput = { id?: string; title: string; folder?: string; text: string };
export type SavedDraft = { id: string; text: string; files: Attachment[]; updatedAt: number };
export type QueuedMessage = { id: string; text: string; files: Attachment[]; queuedAt?: number };
export type SavedQueue = { sessionId: string; paused: boolean; items: QueuedMessage[]; updatedAt: number };
export type BackupResult = { cancelled?: boolean; path?: string; chats?: number; files?: number; bytes?: number };
export type BackupPreview = {
  token: string; fileName: string; size: number; createdAt: number; appVersion: string;
  chats: { total: number; new: number }; attachments: number; prompts: { total: number; new: number };
  projects: { total: number; available: number }; unsent: { drafts: number; queued: number }; preferences: boolean;
};
export type RestoreCategory = 'chats' | 'prompts' | 'preferences' | 'unsent';
export type RestoreResult = { chats: number; skippedChats: number; skippedDrafts: number; skippedQueued: number; attachments: number; prompts: number; projects: number; drafts: number; queued: number; preferences: boolean };
export type ChatDetails = {
  workspace: string; standalone: boolean; sessionId: string;
  /** The home folder, so paths can be shown as ~/…. Older desktop builds omit it. */
  home?: string;
  /** Instruction files the engine reads for this project, broadest first. */
  instructions: { scope: 'app' | 'ancestor' | 'project'; path: string; bytes: number }[];
  directories: string[];
  permissions: { global: Record<string, unknown>; project: Record<string, unknown> };
};
export type FilePreview = { name: string; path: string; size: number; kind: 'image' | 'text' | 'other'; mimeType?: string; data?: string; text?: string; truncated?: boolean; allowed: boolean; canOpen: boolean; canReveal: boolean };
export type ChatSearchResult = { sessionId: string; title: string; role: 'user' | 'assistant'; messageIndex: number; matches: number; updatedAt: number; snippet: string };
export type SubscriptionUsageWindow = { id: string; label: string; usedPercent: number; resetsAt: number | null; windowMinutes: number | null };
export type SubscriptionUsage = { plan: string | null; windows: SubscriptionUsageWindow[] };
export type SettingsScope = 'app' | 'project';
export type UpdateState = { status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'unavailable'; message: string; version?: string; progress?: number };
export type UpdateDraft = { id: string; text: string; files: Attachment[] };
export type SettingsSnapshot = { app: DesktopPreferences; project: Partial<DesktopPreferences>; effective: DesktopPreferences; workspace: string; initialized: boolean };
export type InstructionsFile = { text: string; revision: string; path: string };
export type StartupState = { tabs: { id: string; label: string; workspace: string }[]; active: string };
export type SettingsInfo = { appVersion: string; engineVersion: string; platform: string; architecture: string; historyPath: string; updatesConfigured: boolean; attachments: { count: number; bytes: number; path: string }; enginePreferences: { global: Record<string, unknown>; project: Record<string, unknown>; directories: string[]; path: string } };
export type EngineEvent = { method: string; id?: string | number; params?: unknown };
export type SessionResult = { sessionId: string; configOptions?: unknown; availableCommands?: unknown[]; historyReplayed?: boolean; branch?: ChatBranch };
/** A file attached to a prompt: raw bytes as base64, or valid UTF-8 text. */
export type Attachment = { name: string; mimeType: string; size: number; uri?: string; data?: string; text?: string };
export type VoiceStatus = { available: boolean; name?: string };
export type ProjectSuggestion = { label: string; prompt: string };
/** The context window as last reported for a chat: tokens used and the model's limit. */
export type ChatUsage = { used: number; size?: number; at: number };
export type ChatPreference = { title?: string; pinned?: boolean; archived?: boolean; branch?: ChatBranch; usage?: ChatUsage };
/** A model on a provider, with the name the provider gave it. */
export type ModelReference = { provider: string; model: string; name: string };
export type ModelUsage = ModelReference & { count: number; lastUsed: number };
export type ModelPreferences = { favorites: ModelReference[]; usage: ModelUsage[] };
export type ProjectChangeFile = { path: string; status: string; staged: boolean; unstaged: boolean; untracked: boolean; added: number; removed: number; complete: boolean; binary: boolean };
export type ProjectChangesSnapshot = { workspace: string; kind: 'repository' | 'no-project' | 'not-repository'; files: ProjectChangeFile[]; totalFiles: number; truncated: boolean; checkedAt: number };
export type ProjectFileDiff = { workspace: string; path: string; context?: number; area?: 'staged' | 'unstaged'; oid?: string; sections: { label: string; patch?: string; text?: string; note?: string }[] };
export type GitChange = { path: string; status: string; added: number; removed: number; binary: boolean; complete: boolean; inProject: boolean; partial?: boolean; untracked?: boolean; conflict?: boolean };
export type GitAction = 'retry' | 'terminal' | 'pull' | 'fetch' | 'publish' | 'refresh' | 'branch';
export type GitFailure = { code: string; title: string; message: string; actions: GitAction[]; detail?: string };
export type GitOperation = 'stage' | 'unstage' | 'commit' | 'push' | 'publish' | 'fetch' | 'pull' | 'switch' | 'branch';
export type GitRepositoryState = { workspace: string; kind: 'no-project' | 'not-repository'; checkedAt: number } | {
  workspace: string; kind: 'repository'; project: string; repository: string; name: string;
  /** The selected project's folder inside the repository; empty at the root. */
  scope: string;
  head: { branch: string | null; oid: string | null; detached: boolean; unborn: boolean };
  upstream: { name: string; remote: string; branch: string; gone: boolean } | null;
  ahead: number | null; behind: number | null;
  /** Where Push sends this branch, as Git resolves it. */
  push: { remote: string; branch: string; ref: string; exists: boolean; outgoing: number } | null;
  /** Present when the branch needs publishing before it can be pushed. */
  publish: { reason: 'no-upstream' | 'mismatch'; branch: string; outgoing: number; defaultRemote: string } | null;
  remotes: { name: string; url: string }[];
  fetchedAt: number | null; operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
  identity: { name: string; email: string } | null;
  staged: GitChange[]; unstaged: GitChange[]; conflicts: GitChange[]; totalFiles: number; truncated: boolean;
  /** Fingerprint of what a commit would record. */
  index: string;
  /** GitHub workflows that run when the push destination branch is pushed. */
  workflows: string[];
  busy: GitOperation | null; checkedAt: number;
};
export type GitResult = { ok: boolean; error?: GitFailure; changed?: boolean; state?: GitRepositoryState; commit?: { oid: string; short: string; summary: string }; destination?: string; branch?: string };
export type GitCommitSummary = { oid: string; short: string; author: string; email: string; date: number; parents: string[]; subject: string; body: string; local?: boolean };
export type GitLog = { workspace: string; commits: GitCommitSummary[]; incoming: GitCommitSummary[]; upstream?: string | null };
export type GitCommitDetails = GitCommitSummary & { workspace: string; files: Omit<GitChange, 'inProject'>[] };
export type GitBranch = { name: string; oid: string; upstream: string | null; track: string; date: number; subject: string; current: boolean };
export type GitEvent = { repository: string; operation: GitOperation; phase: 'start' | 'end' | 'progress'; ok?: boolean; step?: string; percent?: number };
export interface DesktopAPI {
  geocodePlace(query: string): Promise<{ lat: number; lon: number; label: string } | null>;
  getSettings(): Promise<SettingsSnapshot>;
  updateSettings(scope: SettingsScope, patch: Partial<DesktopPreferences>): Promise<SettingsSnapshot>;
  resetProjectSettings(): Promise<SettingsSnapshot>;
  getStartup(): Promise<StartupState>;
  saveStartup(state: StartupState): Promise<void>;
  settingsInfo(): Promise<SettingsInfo>;
  getInstructions(scope: SettingsScope): Promise<InstructionsFile>;
  saveInstructions(scope: SettingsScope, text: string, revision: string): Promise<InstructionsFile>;
  openSettingsTarget(target: 'history' | 'attachments' | 'engineSettings' | 'appInstructions' | 'projectInstructions' | 'help' | 'releases'): Promise<void>;
  clearSuggestionCache(): Promise<unknown>;
  clearAttachments(): Promise<{ removed: number }>;
  diagnostics(): Promise<string>;
  commandReport(command: 'status' | 'usage' | 'doctor' | 'version'): Promise<{ command: string; data: unknown; exitCode: number }>;
  checkUpdates(): Promise<{ message: string }>;
  getUpdateState(): Promise<UpdateState>;
  downloadUpdate(): Promise<UpdateState>;
  installUpdate(drafts: UpdateDraft[]): Promise<UpdateState>;
  getUpdateDrafts(): Promise<UpdateDraft[]>;
  testNotification(): Promise<void>;
  setToolPermission(scope: SettingsScope, category: string, action: string): Promise<SettingsInfo>;
  addProjectFolder(): Promise<SettingsInfo | null>;
  removeProjectFolder(folder: string): Promise<SettingsInfo>;
  providerModels(provider: string): Promise<{ configOptions: unknown }>;
  testProvider(provider: string): Promise<{ message: string }>;
  providerUsage(provider: 'codex'): Promise<SubscriptionUsage>;
  exportChats(scope: 'current' | 'all', format: 'markdown' | 'json'): Promise<{ cancelled?: boolean; count?: number; path?: string }>;
  /** `files` of null keeps the attachments already saved for this chat. */
  saveDraft(id: string, text: string, files: Attachment[] | null): Promise<{ saved: boolean; skipped: number }>;
  listDrafts(): Promise<SavedDraft[]>;
  /** Atomically transfers a saved draft without eviction or attachment re-encoding. */
  moveDraft(source: string, target: string): Promise<{ saved: boolean; skipped: number }>;
  removeDrafts(ids: string[]): Promise<{ removed: number }>;
  listQueues(): Promise<SavedQueue[]>;
  saveQueue(sessionId: string, queue: { paused: boolean; items: QueuedMessage[] }): Promise<{ saved: boolean; skipped: number }>;
  createBackup(): Promise<BackupResult>;
  /** Asks for a backup file, verifies it, and describes what restoring would add. */
  previewBackup(): Promise<BackupPreview | { cancelled: true }>;
  restoreBackup(token: string, categories: Partial<Record<RestoreCategory, boolean>>): Promise<RestoreResult>;
  previewFile(target: string): Promise<FilePreview>;
  openFile(target: string): Promise<void>;
  revealFile(target: string): Promise<void>;
  searchChats(query: string): Promise<{ terms: string[]; results: ChatSearchResult[] }>;
  listPrompts(): Promise<SavedPrompt[]>;
  savePrompt(prompt: SavedPromptInput): Promise<SavedPrompt>;
  deletePrompt(id: string): Promise<{ removed: boolean }>;
  /** Resolves to null when the person cancels the capture. */
  captureScreen(): Promise<Attachment | null>;
  quickSubmit(text: string, attachments: Attachment[]): Promise<void>;
  quickDismiss(): Promise<void>;
  quickCapture(): Promise<Attachment | null>;
  quickResize(height: number): Promise<void>;

  updateChat(id: string, changes: Pick<ChatPreference, 'title' | 'pinned' | 'archived'>): Promise<ChatPreference>;
  getModelPreferences(): Promise<ModelPreferences>;
  setModelFavorite(provider: string, model: string, name: string, favorite: boolean): Promise<ModelPreferences>;
  projectSuggestions(): Promise<ProjectSuggestion[]>;
  projectChanges(): Promise<ProjectChangesSnapshot>;
  projectFileDiff(workspace: string, path: string, context: number): Promise<ProjectFileDiff>;
  gitState(workspace: string): Promise<GitRepositoryState>;
  gitFileDiff(workspace: string, path: string, area: 'staged' | 'unstaged', context: number): Promise<ProjectFileDiff>;
  gitStage(workspace: string, paths: string[]): Promise<GitResult>;
  gitUnstage(workspace: string, paths: string[]): Promise<GitResult>;
  gitStageAll(workspace: string): Promise<GitResult>;
  gitUnstageAll(workspace: string): Promise<GitResult>;
  gitCommit(workspace: string, message: { summary: string; description: string }, reviewed: { repository: string; branch: string | null; head: string | null; index: string }): Promise<GitResult>;
  gitCommitMessage(workspace: string): Promise<{ summary: string; description: string; head: string | null; index: string }>;
  gitPush(workspace: string, destination: { remote: string; branch: string }): Promise<GitResult>;
  gitPublish(workspace: string, remote: string): Promise<GitResult>;
  gitFetch(workspace: string): Promise<GitResult>;
  gitPull(workspace: string): Promise<GitResult>;
  gitBranches(workspace: string): Promise<{ workspace: string; current: string | null; branches: GitBranch[] }>;
  gitSwitchBranch(workspace: string, name: string): Promise<GitResult>;
  gitCreateBranch(workspace: string, name: string): Promise<GitResult>;
  gitLog(workspace: string, limit: number): Promise<GitLog>;
  gitCommitDetails(workspace: string, oid: string): Promise<GitCommitDetails>;
  gitCommitFileDiff(workspace: string, oid: string, path: string, context: number): Promise<ProjectFileDiff>;
  gitOpenTerminal(workspace: string): Promise<void>;
  listProjects(): Promise<string[]>;
  removeProject(path: string): Promise<string[]>;
  selectProject(path: string): Promise<{ path: string }>;
  chooseWorkspace(): Promise<{ path: string } | null>;
  /** Reads up to `room` picked files; the rest, and any that cannot be attached, come back with reasons. */
  chooseFiles(room?: number): Promise<{ files: Attachment[]; rejected: { name: string; reason: string }[] }>;
  chatDetails(): Promise<ChatDetails>;
  voiceStatus(): Promise<VoiceStatus>;
  startVoice(): Promise<void>;
  stopVoice(): Promise<void>;
  connect(): Promise<SessionResult>;
  prompt(text: string, attachments: Attachment[], sessionId?: string): Promise<unknown>;
  cancel(sessionId?: string): Promise<void>;
  continueResponse(sessionId?: string): Promise<unknown>;
  newSession(): Promise<SessionResult>;
  newChat(): Promise<SessionResult>;
  selectChat(): Promise<{ path: string }>;
  listSessions(): Promise<unknown>;
  rewindSession(turnIndex: number, expectedText: string): Promise<SessionResult>;
  loadSession(id: string): Promise<SessionResult>;
  readSession(id: string): Promise<{ sessionId: string; title: string; updates: unknown[] }>;
  deleteSession(id: string): Promise<unknown>;
  listProviders(): Promise<unknown>;
  connectProvider(provider: string, apiKey: string): Promise<unknown>;
  disconnectProvider(provider: string): Promise<unknown>;
  signInProvider(provider: string): Promise<unknown>;
  setConfig(configId: string, value: string): Promise<unknown>;
  respondPermission(requestId: string | number, optionId: string | null, sessionId?: string): Promise<void>;
  onEvent(listener: (event: EngineEvent) => void): () => void;
}
declare global {
  interface Window { handwork?: DesktopAPI }
}
