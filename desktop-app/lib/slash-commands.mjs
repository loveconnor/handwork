import catalog from './terminal-slash-commands.json' with { type: 'json' };

/** Generated from the terminal's shared slash_specs, including its aliases and argument hints. */
export const terminalSlashCommands = catalog;
const implemented = new Set(['help', 'new', 'clear', 'resume', 'model', 'reasoning', 'permissions', 'context', 'settings', 'provider', 'fast', 'rename', 'copy', 'diff', 'export', 'status', 'usage', 'doctor', 'version']);
// Desktop commands use native pickers and dialogs, not the terminal's argument syntax.
/** @type {Record<string, string>} */
const desktopInputHints = { model: 'Optional model name', reasoning: 'Optional effort', permissions: 'Optional mode', rename: 'Optional title' };
export const desktopSlashCommands = catalog.filter(command => implemented.has(command.name)).map(command => ({
  ...command,
  input: desktopInputHints[command.name] || '',
}));
export const findSlashCommand = name => catalog.find(command => command.name === name || command.aliases.includes(name));
export const supportsSlashCommand = name => implemented.has(findSlashCommand(name)?.name);

/** Only a whole, single-line command is intercepted. Paths and prose stay messages. */
export function parseSlashCommand(text = '') {
  const match = /^\/([a-z][\w-]*)(?:[\t ]+([^\r\n]*))?$/i.exec(text.trim());
  return match ? { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() } : null;
}

/**
 * @param {string} name
 * @param {string} args
 * @param {import('./desktop-state.ts').ConfigOption[]} options
 * @returns {{kind: 'notice', message: string} | {kind: 'commands' | 'new' | 'activity' | 'resume' | 'copy' | 'diff' | 'export'} | {kind: 'settings', section?: 'models'} | {kind: 'rename', title: string} | {kind: 'report', command: 'status' | 'usage' | 'doctor' | 'version'} | {kind: 'choices', optionId: string} | {kind: 'configure', optionId: string, value: string}}
 */
export function resolveSlashCommand(name, args, options = []) {
  const command = findSlashCommand(name);
  if (!command) return { kind: 'notice', message: `Unknown command /${name}. Use /help to browse available desktop commands.` };
  name = command.name;
  if (!implemented.has(name)) return { kind: 'notice', message: `/${name} is a terminal command, but the bundled engine does not expose it to desktop clients yet. It was not executed or sent to the model.` };
  if (name === 'help') return { kind: 'commands' };
  if (name === 'new' || name === 'clear') return { kind: 'new' };
  if (name === 'settings') return args ? { kind: 'notice', message: 'Use the settings dialog to change desktop settings.' } : { kind: 'settings' };
  if (name === 'provider') return { kind: 'settings', section: 'models' };
  if (name === 'resume') return { kind: 'resume' };
  if (name === 'context') return { kind: 'activity' };
  if (name === 'status' || name === 'usage' || name === 'doctor' || name === 'version') return { kind: 'report', command: name };
  if (name === 'rename') return { kind: 'rename', title: args };
  if (name === 'copy') return { kind: 'copy' };
  if (name === 'diff') return { kind: 'diff' };
  if (name === 'export') return args ? { kind: 'notice', message: 'Use /export without a path to choose a destination in the save dialog.' } : { kind: 'export' };
  const optionId = { model: 'model', reasoning: 'effort', permissions: 'mode', fast: 'fast_mode' }[name];
  const option = options.find(item => item.id === optionId);
  if (!option) return { kind: 'notice', message: `The current session does not offer ${name === 'reasoning' ? 'reasoning effort' : optionId}. Try another model or provider.` };
  if (name === 'fast') return { kind: 'configure', optionId, value: option.currentValue === 'on' ? 'off' : 'on' };
  if (!args) return { kind: 'choices', optionId };
  const needle = args.toLowerCase();
  // Terminal permission names refer to the permission policy, not the displayed session-mode label.
  const policy = name === 'permissions' ? option.options.filter(choice => choice.permissionMode?.replaceAll('_', '-') === needle.replaceAll('_', '-')) : [];
  const exact = policy.length ? policy : option.options.filter(choice => choice.value.toLowerCase() === needle || choice.name.toLowerCase() === needle);
  const matches = exact.length ? exact : option.options.filter(choice => choice.value.toLowerCase().includes(needle) || choice.name.toLowerCase().includes(needle));
  if (matches.length !== 1) return { kind: 'notice', message: `${matches.length ? 'More than one option matches' : 'No option matches'} "${args}". ${option.name || optionId}: ${option.options.map(choice => choice.name).join(', ')}` };
  return { kind: 'configure', optionId, value: matches[0].value };
}
