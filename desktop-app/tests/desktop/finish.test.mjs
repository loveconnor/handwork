import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DesktopBackend } from '../../electron/backend.mjs';
import { readableUserText, chatsToMarkdown, exportFileName } from '../../electron/chat-export.mjs';
import { validateArguments } from '../../electron/ipc.mjs';
import { validSettingsPatch, DesktopSettings } from '../../electron/desktop-settings.mjs';
import { prepareMath } from '../../lib/markdown-math.ts';

test('math is recognised without turning prices or code into equations', () => {
  assert.equal(prepareMath('Area is $\\pi r^2$.'), 'Area is $$\\pi r^2$$.');
  assert.equal(prepareMath('Inline \\(a+b\\) and \\[x\\]'), 'Inline $$a+b$$ and $$x$$');
  for (const text of ['Costs $5 and $10 today', 'Range $5-$10', 'Code `$x$` stays', '```\nprice = "$a$"\n```']) assert.equal(prepareMath(text), text);
  // A display equation that is still streaming stays literal until it closes.
  assert.equal(prepareMath('Done $$x$$ then $$y', true), 'Done $$x$$ then \\$\\$y');
  assert.equal(prepareMath('Done $$x$$ then $$y$$', true), 'Done $$x$$ then $$y$$');
});

test('Markdown exports read like the conversation', () => {
  const { text, attachments } = readableUserText('Compare these\n[Image #1]\nFile: file:///Users/me/report.csv\na,b\n1,2');
  assert.equal(text, 'Compare these');
  assert.deepEqual(attachments, ['Image 1', 'report.csv']);
  const markdown = chatsToMarkdown([{ title: 'Budget review', project: 'finance', messages: [
    { role: 'user', text: 'Compare these\nFile: file:///Users/me/report.csv\na,b' },
    { role: 'assistant', text: 'The **totals** match.' },
  ] }], new Date('2026-10-16T12:00:00Z'));
  assert.match(markdown, /^# Budget review\n\n\*Exported from Handwork on October 16, 2026 · finance\*/);
  assert.match(markdown, /## You\n\n\*Attached: report\.csv\*\n\nCompare these\n\n## Handwork\n\nThe \*\*totals\*\* match\./);
  assert.equal(exportFileName('current', 'markdown', 'Budget review: Q3!'), 'budget-review-q3.md');
  assert.equal(exportFileName('all', 'json'), 'handwork-chats.json');
});

test('the open standalone chat exports from saved history while its engine holds it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-export-'));
  try {
    const destination = path.join(root, 'chat.md');
    const updates = [
      { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'What is 2+2?' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: 'Let me check.' } },
      { sessionUpdate: 'agent_message_chunk', messageId: 'a2', content: { type: 'text', text: 'It is 4.' } },
    ];
    const chatDirectory = path.join(root, 'chats');
    const backend = new DesktopBackend({
      chatDirectory,
      settingsService: { home: root, snapshot: () => ({ effective: {} }), host: { saveExport: async options => { assert.equal(options.defaultName, 'arithmetic.md'); return destination; } } },
      clientFactory: () => {
        // Only the read-only history client is created; nothing reloads the locked chat.
        const client = new EventEmitter();
        Object.assign(client, { closed: false, exited: new Promise(() => {}), dispose() {}, request: async (method, params) => {
          assert.equal(method, 'handwork/session/read');
          for (const update of updates) client.emit('event', { method: 'handwork/session_read_update', params: { sessionId: params.sessionId, update } });
          return { sessionId: params.sessionId, title: 'Arithmetic' };
        } });
        return client;
      },
    });
    const live = { closed: false, request: async method => { assert.equal(method, 'session/list'); return { sessions: [{ sessionId: 'chat-1', cwd: path.join(chatDirectory, 'abc'), title: 'Arithmetic', turns: 1 }] }; } };
    backend.client = live;
    backend.session = { sessionId: 'chat-1' };
    backend.engines.add({ client: live, session: backend.session, directory: path.join(chatDirectory, 'abc'), running: false });

    const result = await backend.exportChats('current', 'markdown');
    assert.deepEqual(result, { path: destination, count: 1 });
    const markdown = await readFile(destination, 'utf8');
    assert.match(markdown, /^# Arithmetic\n\n\*Exported from Handwork on [^·*]+\*\n/, 'standalone chats have no project label');
    assert.match(markdown, /## Handwork\n\nLet me check\.\n\nIt is 4\./);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('IPC and settings accept export formats and background mode only in valid shapes', () => {
  validateArguments('exportChats', ['current', 'markdown']);
  validateArguments('exportChats', ['all', 'json']);
  assert.throws(() => validateArguments('exportChats', ['current']), /Invalid desktop API/);
  assert.throws(() => validateArguments('exportChats', ['current', 'html']), /Invalid desktop API/);
  assert.equal(validSettingsPatch('app', { keepRunning: true }), true);
  assert.equal(validSettingsPatch('app', { keepRunning: 'yes' }), false);
  assert.equal(validSettingsPatch('project', { keepRunning: true }), false);
});

test('appearance preferences accept only the offered accents and palettes, app-wide', () => {
  assert.equal(validSettingsPatch('app', { accent: 'violet', lightPalette: 'mist', darkPalette: 'black' }), true);
  assert.equal(validSettingsPatch('app', { accent: '#ff00ff' }), false);
  assert.equal(validSettingsPatch('app', { lightPalette: 'graphite' }), false);
  assert.equal(validSettingsPatch('app', { darkPalette: 'sand' }), false);
  assert.equal(validSettingsPatch('project', { accent: 'blue' }), false);
});

test('backdrop shaders accept only the offered shaders and strengths, app-wide', () => {
  assert.equal(validSettingsPatch('app', { backdrop: 'aurora', backdropStrength: 'vivid' }), true);
  assert.equal(validSettingsPatch('app', { backdrop: 'none' }), true);
  assert.equal(validSettingsPatch('app', { backdrop: 'plasma' }), false);
  assert.equal(validSettingsPatch('app', { backdropStrength: 1 }), false);
  assert.equal(validSettingsPatch('project', { backdrop: 'silk' }), false);
});

test('settings from a newer version never block the app and are kept for it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'handwork-settings-'));
  try {
    const file = path.join(directory, 'desktop-settings.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify({ version: 1, app: { theme: 'dark', backdrop: 'dune', futureThing: 'x', accent: 'plaid' }, projects: { '/w': { suggestions: false, futureKey: 1 } } }));
    const settings = new DesktopSettings(file);
    const snapshot = settings.snapshot('/w');
    assert.equal(snapshot.app.theme, 'dark');
    assert.equal(snapshot.app.backdrop, 'dune');
    assert.equal(snapshot.app.accent, 'ink');
    assert.equal('futureThing' in snapshot.app, false);
    assert.equal(snapshot.effective.suggestions, false);
    settings.update('app', { theme: 'light' });
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.app.futureThing, 'x');
    assert.equal(saved.app.theme, 'light');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
