import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopSlashCommands, terminalSlashCommands, parseSlashCommand, resolveSlashCommand, supportsSlashCommand } from '../../lib/slash-commands.mjs';

const options = [
  { id: 'model', name: 'Model', currentValue: 'small', options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }, { value: 'large-fast', name: 'Large Fast' }] },
  { id: 'effort', name: 'Reasoning effort', currentValue: 'medium', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  { id: 'mode', name: 'Session mode', currentValue: 'ask', options: [{ value: 'ask', name: 'Ask' }, { value: 'code', name: 'Code' }] },
  { id: 'fast_mode', name: 'Fast mode', currentValue: 'off', options: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'On' }] },
];

test('slash parsing handles whitespace, casing, and arguments without intercepting paths or multiline messages', () => {
  assert.deepEqual(parseSlashCommand('  /MODEL   Large Fast  '), { name: 'model', args: 'Large Fast' });
  assert.deepEqual(parseSlashCommand('/help'), { name: 'help', args: '' });
  for (const text of ['', '/', '/Users/person/file.ts', '/etc/hosts', 'Explain /model', '/help\nwith this code', '// comment']) assert.equal(parseSlashCommand(text), null, text);
});

test('every advertised desktop command has an implementation without engine advertisements', () => {
  const expected = { help: 'commands', new: 'new', clear: 'new', resume: 'resume', model: 'choices', reasoning: 'choices', permissions: 'choices', status: 'report', usage: 'report', context: 'activity', settings: 'settings', rename: 'rename', provider: 'settings', copy: 'copy', diff: 'diff', export: 'export', doctor: 'report', fast: 'configure', version: 'report' };
  assert.deepEqual(desktopSlashCommands.map(command => command.name).sort(), Object.keys(expected).sort());
  for (const command of desktopSlashCommands) {
    assert.equal(supportsSlashCommand(command.name), true);
    assert.equal(resolveSlashCommand(command.name, '', options).kind, expected[command.name]);
    for (const alias of command.aliases) assert.deepEqual(resolveSlashCommand(alias, '', options), resolveSlashCommand(command.name, '', options));
  }
  assert.deepEqual(resolveSlashCommand('help', ''), { kind: 'commands' });
  for (const name of ['status', 'usage', 'doctor', 'version']) assert.deepEqual(resolveSlashCommand(name, ''), { kind: 'report', command: name });
});

test('desktop argument hints describe supported optional inputs without terminal syntax', () => {
  const hints = { model: 'Optional model name', reasoning: 'Optional effort', permissions: 'Optional mode', rename: 'Optional title' };
  for (const command of desktopSlashCommands) {
    assert.equal(command.input, hints[command.name] || '', command.name);
    assert.doesNotMatch(command.input, /[<>\[\]|]/);
  }
  for (const name of ['resume', 'export', 'provider', 'settings', 'fast']) assert.equal(desktopSlashCommands.find(command => command.name === name).input, '');
  assert.equal(terminalSlashCommands.find(command => command.name === 'rename').input, '<title>', 'desktop hints do not modify the shared terminal catalog');
});

test('setting commands open their own picker or resolve a specific supported value', () => {
  for (const [name, optionId, value] of [['model', 'model', 'small'], ['reasoning', 'effort', 'high'], ['permissions', 'mode', 'code']]) {
    assert.deepEqual(resolveSlashCommand(name, '', options), { kind: 'choices', optionId });
    assert.deepEqual(resolveSlashCommand(name, value.toUpperCase(), options), { kind: 'configure', optionId, value });
  }
  assert.deepEqual(resolveSlashCommand('model', 'Large Fast', options), { kind: 'configure', optionId: 'model', value: 'large-fast' });
  assert.deepEqual(resolveSlashCommand('model', 'large', options), { kind: 'configure', optionId: 'model', value: 'large' }, 'exact match wins over partial matches');
});

test('ambiguous, unavailable, and unsupported commands never change settings', () => {
  for (const query of ['lar', 'missing']) assert.equal(resolveSlashCommand('model', query, options).kind, 'notice');
  assert.match(resolveSlashCommand('model', 'lar', options).message, /More than one/);
  assert.match(resolveSlashCommand('permissions', 'code', []).message, /does not offer mode/);
  for (const command of terminalSlashCommands.filter(command => !supportsSlashCommand(command.name))) {
    assert.equal(resolveSlashCommand(command.name, '', options).kind, 'notice');
    assert.match(resolveSlashCommand(command.name, '', options).message, /not executed or sent to the model/);
  }
  assert.match(resolveSlashCommand('unknown', '', options).message, /\/help/);
});
