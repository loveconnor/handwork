import type { DesktopPreferences, QuickEntryShortcut } from './desktop-api';

/** One action and the key combinations that run it. Each combination is "Mod+K" style. */
export type ShortcutItem = { label: string; keys: string[]; detail?: string };
export type ShortcutGroup = { title: string; items: ShortcutItem[] };

const quickEntryKeys: Record<Exclude<QuickEntryShortcut, 'off'>, string> = {
  'Alt+Space': 'Alt+Space', 'Control+Alt+Space': 'Control+Alt+Space', 'CommandOrControl+Shift+Space': 'Mod+Shift+Space',
};

/**
 * Every keyboard shortcut Handwork handles, as shown in the shortcut reference.
 * Keep this list in step with the key handlers it describes.
 */
export function shortcutGroups({ sendKey = 'enter', quickEntryShortcut = 'off', desktop = true, mac = false }: Partial<Pick<DesktopPreferences, 'sendKey' | 'quickEntryShortcut'>> & { desktop?: boolean; mac?: boolean } = {}): ShortcutGroup[] {
  const send = sendKey === 'enter' ? 'Enter' : 'Mod+Enter';
  return [
    { title: 'General', items: [
      { label: 'Search chats and commands', keys: ['Mod+K'] },
      { label: 'New chat', keys: ['Mod+N'] },
      { label: 'Next chat that needs you', keys: ['Mod+Shift+A'], detail: 'Approvals, failed or paused replies, and paused queues.' },
      { label: 'Chat details', keys: ['Mod+I'] },
      ...(desktop ? [{ label: 'Settings', keys: ['Mod+,'] }] : []),
      { label: 'Keyboard shortcuts', keys: ['Mod+/'] },
      ...(desktop && quickEntryShortcut !== 'off' ? [{ label: 'Quick entry from any app', keys: [quickEntryKeys[quickEntryShortcut]], detail: 'Change it in Settings › General.' }] : []),
    ] },
    ...(desktop ? [{ title: 'Tabs', items: [
      { label: 'Next tab', keys: ['Control+Tab', 'Mod+Shift+]'] },
      { label: 'Previous tab', keys: ['Control+Shift+Tab', 'Mod+Shift+['] },
      { label: 'Go to tab 1 to 8', keys: ['Mod+1'], detail: 'Use the number of the tab.' },
      { label: 'Go to the last tab', keys: ['Mod+9'] },
      { label: 'Reopen closed tab', keys: ['Mod+Shift+T'] },
      { label: 'Close tab', keys: ['Mod+W'], detail: 'The chat stays in the sidebar.' },
    ] }] : []),
    ...(desktop ? [{ title: 'Code', items: [
      { label: 'IDE view', keys: ['Mod+Shift+E'], detail: 'The project’s code first, with the chat beside it.' },
      { label: 'Show or hide the chat', keys: ['Mod+J'], detail: 'In the IDE view.' },
      { label: 'Ask about the selection', keys: ['Mod+L'], detail: 'Shows the chat with the selected lines attached.' },
      { label: 'Go to file', keys: ['Mod+P'] },
      { label: 'Search in files', keys: ['Mod+Shift+F'] },
      { label: 'Terminal', keys: ['Control+`'] },
      { label: 'Go to definition', keys: ['F12'], detail: mac ? 'Or ⌘-click a name.' : 'Or Ctrl-click a name.' },
      { label: 'Find references', keys: ['Shift+F12'] },
      { label: 'Rename symbol', keys: ['F2'] },
      { label: 'Format document', keys: ['Shift+Alt+F'] },
      { label: 'Save file', keys: ['Mod+S'] },
    ] }] : []),
    { title: 'Composer', items: [
      { label: 'Send message', keys: [send], detail: sendKey === 'enter' ? undefined : 'Enter adds a new line.' },
      { label: 'New line', keys: sendKey === 'enter' ? ['Shift+Enter'] : ['Enter', 'Shift+Enter'] },
      { label: 'Slash commands and saved prompts', keys: ['/'] },
      { label: 'Move through suggestions', keys: ['ArrowUp+ArrowDown'] },
      { label: 'Choose a suggestion', keys: ['Enter', 'Tab'] },
      { label: 'Dismiss suggestions', keys: ['Escape'] },
    ] },
    { title: 'Conversation', items: [
      { label: 'Find in chat', keys: ['Mod+F'] },
      { label: 'Next match', keys: ['Enter', 'Mod+G'] },
      { label: 'Previous match', keys: ['Shift+Enter', 'Mod+Shift+G'] },
      { label: 'Save an edited message and regenerate', keys: ['Enter'] },
      { label: 'Close find, an edit, or the side panel', keys: ['Escape'] },
    ] },
    { title: 'Command palette', items: [
      { label: 'Move through results', keys: ['ArrowUp+ArrowDown'] },
      { label: 'Open or choose', keys: ['Enter'] },
      { label: 'Back to all commands', keys: ['Backspace'], detail: 'When the filter is empty.' },
      { label: 'Close', keys: ['Escape'] },
    ] },
    ...(desktop ? [{ title: 'Window', items: [
      { label: 'Zoom in', keys: ['Mod+Plus'] },
      { label: 'Zoom out', keys: ['Mod+Minus'] },
      { label: 'Actual size', keys: ['Mod+0'] },
      { label: 'Full screen', keys: [mac ? 'Control+Mod+F' : 'F11'] },
      { label: 'Close window', keys: ['Mod+Shift+W'] },
      ...(mac ? [{ label: 'Quit Handwork', keys: ['Mod+Q'] }] : []),
    ] }] : []),
  ];
}
