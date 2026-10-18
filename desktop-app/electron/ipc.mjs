import { validSettingsPatch } from './desktop-settings.mjs';
import { validPromptInput } from './saved-prompts.mjs';
import { validObjectId, validRefName, validRepositoryPath } from './git-service.mjs';
export const CHANNEL_PREFIX = 'handwork:';
export const EVENT_CHANNEL = 'handwork:event';
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !value.includes('\0');
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_PROMPT_BYTES = 7 * 1024 * 1024; // stays under the engine's 8MB frame
const base64 = (value) => typeof value === 'string' && (value === '' || (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0));
// Attachments carry base64 file bytes or UTF-8 text.
export const attachments = (value) => Array.isArray(value) && value.length <= MAX_ATTACHMENTS && value.every((item) =>
  item && typeof item === 'object' && text(item.name, 512) && text(item.mimeType, 128) &&
  (item.uri === undefined || text(item.uri, 4096)) &&
  ((typeof item.data === 'string' && item.text === undefined && base64(item.data) && item.data.length <= Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) ||
   (typeof item.text === 'string' && item.data === undefined && Buffer.byteLength(item.text) <= MAX_ATTACHMENT_BYTES && !item.text.includes('\0'))),
) && value.reduce((total, item) => total + (item.data?.length ?? Buffer.byteLength(item.text ?? '')), 0) <= MAX_PROMPT_BYTES;
const scope = value => ['app', 'project'].includes(value);
const draftKey = value => text(value, 512) && /^[a-zA-Z0-9_.:-]+$/.test(value);
const fileTarget = value => text(value, 4096) && !/[\x00-\x1f]/.test(value);
const queuedMessage = item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(item.id) &&
  typeof item.text === 'string' && Buffer.byteLength(item.text) <= 1024 * 1024 && !item.text.includes('\0') && attachments(item.files) &&
  (item.queuedAt === undefined || (Number.isSafeInteger(item.queuedAt) && item.queuedAt >= 0));
export const validQueue = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => ['paused', 'items'].includes(key)) &&
  typeof value.paused === 'boolean' && Array.isArray(value.items) && value.items.length <= 50 && value.items.every(queuedMessage) &&
  new Set(value.items.map(item => item.id)).size === value.items.length && Buffer.byteLength(JSON.stringify(value)) <= 96 * 1024 * 1024;
const restoreChoices = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0 &&
  Object.entries(value).every(([key, item]) => ['chats', 'prompts', 'preferences', 'unsent'].includes(key) && typeof item === 'boolean');
export const validUpdateDrafts = value => Array.isArray(value) && value.length <= 30 && value.every(draft =>
  draft && typeof draft.id === 'string' && draft.id.length <= 512 && typeof draft.text === 'string' &&
  Buffer.byteLength(draft.text) <= 1024 * 1024 && !draft.text.includes('\0') && attachments(draft.files),
) && Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024 * 1024;
const plain = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const diffContext = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000;
const repositoryPaths = value => Array.isArray(value) && value.length > 0 && value.length <= 1000 && value.every(validRepositoryPath) && new Set(value).size === value.length;
const commitMessage = value => plain(value, ['summary', 'description']) && typeof value.summary === 'string' && value.summary.trim().length > 0 && Buffer.byteLength(value.summary) <= 1024 && !/[\x00-\x1f]/.test(value.summary) &&
  typeof value.description === 'string' && Buffer.byteLength(value.description) <= 64 * 1024 && !value.description.includes('\0');
// The repository state the person reviewed; the commit is refused if it no longer matches.
const reviewedCommit = value => plain(value, ['repository', 'branch', 'head', 'index']) && text(value.repository) && (value.branch === null || validRefName(value.branch)) &&
  (value.head === null || /^[0-9a-f]{40,64}$/.test(value.head)) && /^[a-f0-9]{64}$/.test(value.index);
const pushDestination = value => plain(value, ['remote', 'branch']) && validRefName(value.remote) && validRefName(value.branch);
const signatures = {
  commandReport: [value => ['status', 'usage', 'doctor', 'version'].includes(value)],
  getUpdateState: [], downloadUpdate: [], installUpdate: [validUpdateDrafts], getUpdateDrafts: [],
  geocodePlace: [value => text(value, 800) && value.trim().length >= 2 && value.length <= 200 && !/[\x00-\x1f]/.test(value)],
  getSettings: [], settingsInfo: [], getStartup: [], resetProjectSettings: [], clearSuggestionCache: [], clearAttachments: [], diagnostics: [], checkUpdates: [], addProjectFolder: [], testNotification: [],
  updateSettings: [scope, value => validSettingsPatch('app', value)],
  saveStartup: [value => value && Array.isArray(value.tabs) && value.tabs.length <= 30 && typeof value.active === 'string' && value.tabs.every(tab => tab && text(tab.id, 512) && text(tab.label, 800) && (tab.workspace === '' || text(tab.workspace))) && (!value.active || value.tabs.some(tab => tab.id === value.active))],
  getInstructions: [scope],
  saveInstructions: [scope, value => typeof value === 'string' && Buffer.byteLength(value) <= 65536 && !value.includes('\0'), value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)],
  openSettingsTarget: [value => ['history', 'attachments', 'engineSettings', 'appInstructions', 'projectInstructions', 'help', 'releases'].includes(value)],
  setToolPermission: [scope, value => ['read', 'edit', 'bash', 'web_fetch', 'web_search'].includes(value), value => ['inherit', 'ask', 'allow', 'deny'].includes(value)],
  removeProjectFolder: [value => text(value)],
  providerModels: [value => text(value, 64)], testProvider: [value => text(value, 64)], providerUsage: [value => value === 'codex'],
  exportChats: [value => ['current', 'all'].includes(value), value => ['json', 'markdown'].includes(value)],
  saveDraft: [draftKey, value => typeof value === 'string' && Buffer.byteLength(value) <= 1024 * 1024 && !value.includes('\0'), value => value === null || attachments(value)],
  listQueues: [], saveQueue: [draftKey, validQueue],
  createBackup: [], previewBackup: [], restoreBackup: [value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value), restoreChoices],
  listDrafts: [], moveDraft: [draftKey, value => draftKey(value) && value !== '__proto__'], removeDrafts: [value => Array.isArray(value) && value.length <= 200 && value.every(draftKey)],
  previewFile: [fileTarget], openFile: [fileTarget], revealFile: [fileTarget],
  searchChats: [value => text(value, 800) && value.length <= 200], listPrompts: [], savePrompt: [validPromptInput], deletePrompt: [value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)], captureScreen: [],
  updateChat: [(value) => text(value), (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => key === 'title' ? text(value.title, 800) && value.title.trim().length > 0 && value.title.trim().length <= 200 && !/[\r\n]/.test(value.title) : ['pinned', 'archived'].includes(key) && typeof value[key] === 'boolean')],
  getModelPreferences: [], setModelFavorite: [value => value === '' || (text(value, 64) && /^[\w.-]+$/.test(value)), value => text(value, 400) && !/[\x00-\x1f]/.test(value), value => text(value, 400) && !/[\x00-\x1f]/.test(value), value => typeof value === 'boolean'],
  gitState: [text], gitFileDiff: [text, validRepositoryPath, value => ['staged', 'unstaged'].includes(value), diffContext],
  gitStage: [text, repositoryPaths], gitUnstage: [text, repositoryPaths], gitStageAll: [text], gitUnstageAll: [text],
  gitCommit: [text, commitMessage, reviewedCommit], gitCommitMessage: [text],
  gitPush: [text, pushDestination], gitPublish: [text, validRefName], gitFetch: [text], gitPull: [text],
  gitBranches: [text], gitSwitchBranch: [text, validRefName], gitCreateBranch: [text, validRefName],
  gitLog: [text, value => Number.isSafeInteger(value) && value >= 1 && value <= 200], gitCommitDetails: [text, validObjectId], gitCommitFileDiff: [text, validObjectId, validRepositoryPath, diffContext],
  gitOpenTerminal: [text],
  projectSuggestions: [], projectChanges: [], projectFileDiff: [value => text(value), value => text(value), value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000], listProjects: [], removeProject: [value => text(value)], selectProject: [(value) => text(value)], selectChat: [], newChat: [],
  chooseWorkspace: [], chooseFiles: [value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_ATTACHMENTS], chatDetails: [], voiceStatus: [], startVoice: [], stopVoice: [], connect: [], cancel: [], continueResponse: [], newSession: [], listSessions: [],
  prompt: [(value) => typeof value === 'string' && Buffer.byteLength(value) <= 1024 * 1024 && !value.includes('\0'), attachments],
  rewindSession: [(value) => Number.isSafeInteger(value) && value >= 0 && value <= 100000, (value) => typeof value === 'string' && Buffer.byteLength(value) <= 1024 * 1024 && !value.includes('\0')],
  loadSession: [(value) => text(value)],
  readSession: [(value) => text(value, 512)],
  deleteSession: [(value) => text(value)],
  listProviders: [],
  connectProvider: [(value) => text(value, 64), (value) => text(value, 8192)],
  disconnectProvider: [(value) => text(value, 64)],
  signInProvider: [(value) => text(value, 64)],
  setConfig: [(value) => text(value), (value) => text(value)],
  respondPermission: [(value) => text(value) || Number.isSafeInteger(value), (value) => value === null || text(value)],
};

export function isTrustedSender(event, webContents, rendererURL) {
  if (!webContents || webContents.isDestroyed() || event.sender !== webContents || !event.senderFrame || event.senderFrame !== webContents.mainFrame) return false;
  try {
    const actual = new URL(event.senderFrame.url);
    const expected = new URL(rendererURL);
    actual.hash = '';
    expected.hash = '';
    return actual.href === expected.href;
  } catch { return false; }
}

export function allowsDesktopPermission(webContents, expectedWindow, rendererURL, permission, details) {
  if (permission !== 'clipboard-sanitized-write' || !details?.isMainFrame || webContents !== expectedWindow) return false;
  if (!isTrustedSender({ sender: webContents, senderFrame: webContents?.mainFrame }, expectedWindow, rendererURL)) return false;
  try { const actual = new URL(details.requestingUrl); const expected = new URL(rendererURL); actual.hash = ''; expected.hash = ''; return actual.href === expected.href; } catch { return false; }
}

export function validateArguments(method, args) {
  const signature = Object.hasOwn(signatures, method) ? signatures[method] : null;
  if (!signature || !Array.isArray(args)) throw new Error('Invalid desktop API arguments');
  // Older renderers send only text; match the backend's empty-attachments default.
  let values = method === 'prompt' && args.length === 1 ? [args[0], []] : method === 'chooseFiles' && args.length === 0 ? [MAX_ATTACHMENTS] : args;
  if (['prompt', 'cancel', 'continueResponse', 'respondPermission'].includes(method) && values.length === signature.length + 1) {
    if (!text(values.at(-1), 512) || !/^[a-zA-Z0-9_.:-]+$/.test(values.at(-1))) throw new Error('Invalid desktop session ID');
    values = values.slice(0, -1);
  }
  if (signature.length !== values.length) {
    throw new Error(`Invalid desktop API arguments: ${method} received ${args.length} arguments; expected ${signature.length}`);
  }
  if (method === 'updateSettings' && !validSettingsPatch(values[0], values[1])) throw new Error('Invalid desktop setting scope');
  const invalid = signature.findIndex((check, index) => !check(values[index]));
  if (invalid !== -1) {
    const detail = method === 'prompt'
      ? (invalid === 0 ? 'text must be a string of at most 1 MB without null characters' : 'attachments must be an array of up to 10 valid files within size limits')
      : `argument ${invalid + 1} is invalid`;
    throw new Error(`Invalid desktop API arguments: ${method}: ${detail}`);
  }
}

export function registerIpc({ ipcMain, webContents, rendererURL, backend, chooseWorkspace, chooseFiles }) {
  for (const method of Object.keys(signatures)) {
    ipcMain.handle(CHANNEL_PREFIX + method, (event, ...args) => {
      if (!isTrustedSender(event, webContents, rendererURL)) throw new Error('Untrusted desktop IPC sender');
      validateArguments(method, args);
      if (method === 'chooseWorkspace') return backend.chooseWorkspace(chooseWorkspace);
      if (method === 'chooseFiles') return backend.chooseFiles(chooseFiles, args[0]);
      return backend[method](...args);
    });
  }
  const forward = (event) => {
    if (!webContents.isDestroyed()) webContents.send(EVENT_CHANNEL, event);
  };
  backend.on('event', forward);
  return () => {
    backend.off('event', forward);
    for (const method of Object.keys(signatures)) ipcMain.removeHandler(CHANNEL_PREFIX + method);
  };
}
