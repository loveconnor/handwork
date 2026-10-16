import { validSettingsPatch } from './desktop-settings.mjs';
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
export const validUpdateDrafts = value => Array.isArray(value) && value.length <= 30 && value.every(draft =>
  draft && typeof draft.id === 'string' && draft.id.length <= 512 && typeof draft.text === 'string' &&
  Buffer.byteLength(draft.text) <= 1024 * 1024 && !draft.text.includes('\0') && attachments(draft.files),
) && Buffer.byteLength(JSON.stringify(value)) <= 32 * 1024 * 1024;
const signatures = {
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
  providerModels: [value => text(value, 64)], testProvider: [value => text(value, 64)],
  exportChats: [value => ['current', 'all'].includes(value)],
  updateChat: [(value) => text(value), (value) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => key === 'title' ? text(value.title, 800) && value.title.trim().length > 0 && value.title.trim().length <= 200 && !/[\r\n]/.test(value.title) : key === 'pinned' && typeof value.pinned === 'boolean')],
  projectSuggestions: [], projectChanges: [], projectFileDiff: [value => text(value), value => text(value), value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000], listProjects: [], selectProject: [(value) => text(value)], selectChat: [], newChat: [],
  chooseWorkspace: [], chooseFiles: [], voiceStatus: [], startVoice: [], stopVoice: [], connect: [], cancel: [], newSession: [], listSessions: [],
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
  let values = method === 'prompt' && args.length === 1 ? [args[0], []] : args;
  if (['prompt', 'cancel', 'respondPermission'].includes(method) && values.length === signature.length + 1) {
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
      if (method === 'chooseFiles') return backend.chooseFiles(chooseFiles);
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
