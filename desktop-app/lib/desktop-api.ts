export type DesktopPreferences = {
  theme: 'system' | 'light' | 'dark'; uiFontSize: number; codeFontSize: number;
  sendKey: 'enter' | 'modifier-enter'; restoreChats: boolean; preferredEditor: 'system' | 'vscode' | 'cursor' | 'zed';
  defaultProvider: string; defaultModel: string; defaultMode: 'ask' | 'code'; suggestions: boolean;
  notifyComplete: boolean; notifyApproval: boolean; notifyError: boolean; notificationSound: boolean; notificationsBackgroundOnly: boolean;
};
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
  exportChats(scope: 'current' | 'all'): Promise<{ cancelled?: boolean; count?: number; path?: string }>;

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
