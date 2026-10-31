import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineSourceRoot } from '../electron/engine-path.mjs';

/** Extract presentation metadata, not execution policy, from the terminal's shared registry. */
export function parseSlashRegistry(source) {
  const block = /pub const slash_specs = \[_\]SlashSpec\{([\s\S]*?)\n\};/.exec(source)?.[1];
  if (!block) throw new Error('Terminal slash registry was not found');
  const entries = block.split('\n').filter(line => line.includes('.kind ='));
  const stringField = (line, field) => {
    const raw = new RegExp(`\\.${field}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")`).exec(line)?.[1];
    return raw ? JSON.parse(raw) : '';
  };
  const commands = entries.map(line => {
    const command = stringField(line, 'command');
    const description = stringField(line, 'completion_description');
    const category = /\.presentation_category\s*=\s*\.(\w+)/.exec(line)?.[1];
    if (!/^\/[a-z][\w-]*$/.test(command) || !description || !category) throw new Error('Unsupported terminal slash registry format');
    const aliases = [...(/\.aliases\s*=\s*&\.\{([^}]*)\}/.exec(line)?.[1] ?? '').matchAll(/"(\/[\w-]+)"/g)].map(match => match[1].slice(1));
    const help = stringField(line, 'help_entry');
    const input = help.slice(command.length).replace(/\s+\(\/.*\)$/, '').trim();
    return { name: command.slice(1), description, category, aliases, showAliases: !line.includes('.show_aliases_in_completion = false'), input };
  });
  if (!commands.length || new Set(commands.map(command => command.name)).size !== commands.length) throw new Error('Invalid terminal slash command catalog');
  return commands;
}

export async function buildSlashCommands(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const destination = path.join(root, 'lib/terminal-slash-commands.json');
  const source = path.join(engineSourceRoot(root), 'src/builtins/commands.zig');
  let text;
  try { text = await readFile(source, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Source-only desktop checkouts retain the catalog shipped with their engine revision.
    const saved = JSON.parse(await readFile(destination, 'utf8'));
    if (!Array.isArray(saved) || !saved.length) throw new Error('Terminal slash command catalog is unavailable');
    return saved;
  }
  const commands = parseSlashRegistry(text);
  await writeFile(destination, JSON.stringify(commands, null, 2) + '\n');
  return commands;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSlashCommands();
