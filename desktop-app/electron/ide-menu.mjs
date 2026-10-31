/** What the IDE view's menus can ask the window to do. */
export const IDE_ACTIONS = Object.freeze([
  'new-file', 'new-folder', 'open-project', 'quick-open', 'save', 'save-all', 'close-editor', 'reveal',
  'toggle-sidebar', 'search', 'toggle-chat', 'terminal', 'split-right', 'split-down', 'ide-view',
  'definition', 'references', 'rename', 'format', 'new-terminal', 'split-terminal',
]);

/**
 * The menus the IDE view adds, arranged as VS Code arranges them. Keys the
 * window already handles (in the editor, the workbench or the app) are shown
 * beside their items but left to the window, so the editor still gets them.
 */
export function ideMenus(run, { mac = process.platform === 'darwin' } = {}) {
  const item = (label, action, accelerator, handledInWindow = true) => ({
    label, click: () => run(action),
    ...(accelerator ? { accelerator, registerAccelerator: !handledInWindow } : {}),
  });
  const separator = { type: 'separator' };
  return {
    file: { label: 'File', submenu: [
      item('New File…', 'new-file'), item('New Folder…', 'new-folder'), separator,
      item('Open Folder…', 'open-project', 'CmdOrCtrl+O', false), separator,
      item('Go to File…', 'quick-open', 'CmdOrCtrl+P'), separator,
      item('Save', 'save', 'CmdOrCtrl+S'), item('Save All', 'save-all', 'Alt+CmdOrCtrl+S', false), separator,
      item('Close Editor', 'close-editor'), item(mac ? 'Reveal in Finder' : 'Show in Folder', 'reveal'),
    ] },
    view: [
      item('Explorer', 'toggle-sidebar'), item('Search', 'search', 'CmdOrCtrl+Shift+F'),
      item('Chat', 'toggle-chat', 'CmdOrCtrl+J'), item('Terminal', 'terminal', 'Ctrl+`'), separator,
      item('Split Editor Right', 'split-right'), item('Split Editor Down', 'split-down'), separator,
      item('Leave IDE View', 'ide-view', 'CmdOrCtrl+Shift+E'),
    ],
    go: { label: 'Go', submenu: [
      item('Go to File…', 'quick-open', 'CmdOrCtrl+P'), separator,
      item('Go to Definition', 'definition', 'F12'), item('Find References', 'references', 'Shift+F12'), separator,
      item('Rename Symbol', 'rename', 'F2'), item('Format Document', 'format', 'Shift+Alt+F'),
    ] },
    terminal: { label: 'Terminal', submenu: [
      item('New Terminal', 'new-terminal', 'Ctrl+Shift+`', false), item('Split Terminal', 'split-terminal'), separator,
      item('Show Terminal', 'terminal', 'Ctrl+`'),
    ] },
  };
}
