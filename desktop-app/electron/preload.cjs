const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed CommonJS preload: no Node APIs, arbitrary channels, or raw RPC escape hatch.
const api = {};
for (const method of ['geocodePlace', 'getSettings', 'settingsInfo', 'getStartup', 'saveStartup', 'updateSettings', 'resetProjectSettings', 'getInstructions', 'saveInstructions', 'openSettingsTarget', 'clearSuggestionCache', 'clearAttachments', 'diagnostics', 'checkUpdates', 'getUpdateState', 'downloadUpdate', 'installUpdate', 'getUpdateDrafts', 'setToolPermission', 'addProjectFolder', 'removeProjectFolder', 'providerModels', 'testProvider', 'exportChats', 'searchChats', 'saveDraft', 'listDrafts', 'removeDrafts', 'previewFile', 'openFile', 'revealFile', 'listPrompts', 'savePrompt', 'deletePrompt', 'captureScreen', 'testNotification', 'updateChat', 'projectSuggestions', 'projectChanges', 'projectFileDiff', 'listProjects', 'selectProject', 'chooseWorkspace', 'chooseFiles', 'voiceStatus', 'startVoice', 'stopVoice', 'connect', 'prompt', 'cancel', 'newSession', 'newChat', 'selectChat', 'listSessions', 'readSession', 'loadSession', 'rewindSession', 'deleteSession', 'setConfig', 'respondPermission', 'listProviders', 'connectProvider', 'disconnectProvider', 'signInProvider']) {
  api[method] = (...args) => ipcRenderer.invoke(`handwork:${method}`, ...args);
}
// The quick entry window may only hand its prompt to the main window or close itself.
for (const method of ['quickSubmit', 'quickDismiss', 'quickCapture', 'quickResize']) {
  api[method] = (...args) => ipcRenderer.invoke(`handwork-quick:${method}`, ...args);
}
api.onEvent = (listener) => {
  if (typeof listener !== 'function') throw new TypeError('Expected an event listener');
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on('handwork:event', wrapped);
  return () => ipcRenderer.removeListener('handwork:event', wrapped);
};
contextBridge.exposeInMainWorld('handwork', Object.freeze(api));
