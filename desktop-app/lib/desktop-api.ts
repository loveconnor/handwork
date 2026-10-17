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
export type FilePreview = { name: string; path: string; size: number; kind: 'image' | 'text' | 'other'; mimeType?: string; data?: string; text?: string; truncated?: boolean; allowed: boolean; canOpen: boolean; canReveal: boolean };
export type ChatSearchResult = { sessionId: string; title: string; role: 'user' | 'assistant'; messageIndex: number; matches: number; updatedAt: number; snippet: string };
export type SettingsScope = 'app' | 'project';
export type UpdateState = { status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'unavailable'; message: string; version?: string; progress?: number };
export type UpdateDraft = { id: string; text: string; files: Attachment[] };
export type SettingsSnapshot = { app: DesktopPreferences; project: Partial<DesktopPreferences>; effective: DesktopPreferences; workspace: string; initialized: boolean };
export type InstructionsFile = { text: string; revision: string; path: string };
export type StartupState = { tabs: { id: string; label: string; workspace: string }[]; active: string };
export type SettingsInfo = { appVersion: string; engineVersion: string; platform: string; architecture: string; historyPath: string; updatesConfigured: boolean; attachments: { count: number; bytes: number; path: string }; enginePreferences: { global: Record<string, unknown>; project: Record<string, unknown>; directories: string[]; path: string } };
export type EngineEvent = { method: string; id?: string | number; params?: unknown };
export type SessionResult = { sessionId: string; configOptions?: unknown; historyReplayed?: boolean };
/** A file attached to a prompt: raw bytes as base64, or valid UTF-8 text. */
export type Attachment = { name: string; mimeType: string; size: number; uri?: string; data?: string; text?: string };
export type VoiceStatus = { available: boolean; name?: string };
export type ProjectSuggestion = { label: string; prompt: string };
export type ChatPreference = { title?: string; pinned?: boolean };
export type ProjectChangeFile = { path: string; status: string; staged: boolean; unstaged: boolean; untracked: boolean; added: number; removed: number; complete: boolean; binary: boolean };
export type ProjectChangesSnapshot = { workspace: string; kind: 'repository' | 'no-project' | 'not-repository'; files: ProjectChangeFile[]; totalFiles: number; truncated: boolean; checkedAt: number };
export type ProjectFileDiff = { workspace: string; path: string; context?: number; sections: { label: string; patch?: string; text?: string; note?: string }[] };
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
  exportChats(scope: 'current' | 'all', format: 'markdown' | 'json'): Promise<{ cancelled?: boolean; count?: number; path?: string }>;
  /** `files` of null keeps the attachments already saved for this chat. */
  saveDraft(id: string, text: string, files: Attachment[] | null): Promise<{ saved: boolean; skipped: number }>;
  listDrafts(): Promise<SavedDraft[]>;
  removeDrafts(ids: string[]): Promise<{ removed: number }>;
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

  updateChat(id: string, changes: ChatPreference): Promise<ChatPreference>;
  projectSuggestions(): Promise<ProjectSuggestion[]>;
  projectChanges(): Promise<ProjectChangesSnapshot>;
  projectFileDiff(workspace: string, path: string, context: number): Promise<ProjectFileDiff>;
  listProjects(): Promise<string[]>;
  selectProject(path: string): Promise<{ path: string }>;
  chooseWorkspace(): Promise<{ path: string } | null>;
  chooseFiles(): Promise<Attachment[]>;
  voiceStatus(): Promise<VoiceStatus>;
  startVoice(): Promise<void>;
  stopVoice(): Promise<void>;
  connect(): Promise<SessionResult>;
  prompt(text: string, attachments: Attachment[], sessionId?: string): Promise<unknown>;
  cancel(sessionId?: string): Promise<void>;
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
