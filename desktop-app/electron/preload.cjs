const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed CommonJS preload: no Node APIs, arbitrary channels, or raw RPC escape hatch.
const api = {};
for (const method of ['mobileStatus', 'mobileInvite', 'mobileCancelInvite', 'mobileRevoke', 'mobileConfigure', 'windowAction', 'geocodePlace', 'getSettings', 'settingsInfo', 'getStartup', 'saveStartup', 'updateSettings', 'resetProjectSettings', 'getInstructions', 'saveInstructions', 'openSettingsTarget', 'clearSuggestionCache', 'clearAttachments', 'diagnostics', 'commandReport', 'checkUpdates', 'getUpdateState', 'downloadUpdate', 'installUpdate', 'getUpdateDrafts', 'setToolPermission', 'addProjectFolder', 'removeProjectFolder', 'providerModels', 'testProvider', 'providerUsage', 'codexResets', 'useCodexReset', 'providerUpdates', 'updateProvider', 'listProjectFiles', 'readProjectFile', 'writeProjectFile', 'createProjectPath', 'renameProjectPath', 'deleteProjectPath', 'indexProjectFiles', 'searchProjectFiles', 'projectFileBase', 'openTerminal', 'writeTerminal', 'resizeTerminal', 'closeTerminal', 'lspStart', 'lspSend', 'lspStop', 'terminalHistory', 'exportChats', 'searchChats', 'saveDraft', 'listDrafts', 'moveDraft', 'removeDrafts', 'listQueues', 'saveQueue', 'createBackup', 'previewBackup', 'restoreBackup', 'previewFile', 'openFile', 'revealFile', 'listPrompts', 'savePrompt', 'deletePrompt', 'captureScreen', 'testNotification', 'updateChat', 'getModelPreferences', 'setModelFavorite', 'projectSuggestions', 'projectChanges', 'projectFileDiff', 'gitState', 'gitFileDiff', 'gitStage', 'gitUnstage', 'gitStageAll', 'gitUnstageAll', 'gitCommit', 'gitCommitMessage', 'gitPush', 'gitPublish', 'gitFetch', 'gitPull', 'gitBranches', 'gitSwitchBranch', 'gitCreateBranch', 'gitLog', 'gitCommitDetails', 'gitCommitFileDiff', 'gitOpenTerminal', 'listProjects', 'removeProject', 'selectProject', 'chooseWorkspace', 'chooseFiles', 'chatDetails', 'voiceStatus', 'transcribeVoice', 'cancelVoice', 'connect', 'prompt', 'cancel', 'continueResponse', 'newSession', 'newChat', 'selectChat', 'listSessions', 'readSession', 'loadSession', 'rewindSession', 'deleteSession', 'setConfig', 'respondPermission', 'listProviders', 'connectProvider', 'disconnectProvider', 'signInProvider']) {
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
