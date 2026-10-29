import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Terminals, defaultShell } from '../../electron/terminals.mjs';
import { validateArguments } from '../../electron/ipc.mjs';

/** A pretend pty that records what it was asked to do. */
function fakeSpawn(log) {
  return (file, args, options) => {
    const handlers = {};
    const pty = { file, args, options, written: '', killed: false, size: [options.cols, options.rows],
      onData: fn => { handlers.data = fn; }, onExit: fn => { handlers.exit = fn; },
      write: data => { pty.written += data; }, resize: (cols, rows) => { pty.size = [cols, rows]; }, kill: () => { pty.killed = true; },
      emit: data => handlers.data(data), exit: code => handlers.exit({ exitCode: code }) };
    log.push(pty);
    return pty;
  };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a terminal is a login shell in the project, without Electron’s own switches', () => {
  const spawned = [];
  const terminals = new Terminals({ emit: () => {}, spawn: fakeSpawn(spawned), env: { SHELL: '/bin/sh', HOME: '/home/me', PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' }, platform: 'darwin' });
  const opened = terminals.open('/work/project', 100, 30);
  assert.match(opened.id, /^[0-9a-f-]{36}$/);
  assert.equal(opened.shell, 'sh');
  const [pty] = spawned;
  assert.deepEqual([pty.file, pty.args, pty.options.cwd, pty.options.cols, pty.options.rows], ['/bin/sh', ['-l'], '/work/project', 100, 30]);
  assert.equal(pty.options.env.TERM, 'xterm-256color');
  assert.equal(pty.options.env.PATH, '/bin');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in pty.options.env) && !('NODE_OPTIONS' in pty.options.env));
  assert.equal(defaultShell({}, 'win32').file, 'powershell.exe');
});

test('output is batched into a few messages, and exit is reported after the last of it', async () => {
  const spawned = [], events = [];
  const terminals = new Terminals({ emit: event => events.push(event), spawn: fakeSpawn(spawned), env: { SHELL: '/bin/sh' }, platform: 'linux' });
  const { id } = terminals.open('/p', 80, 24);
  for (let i = 0; i < 200; i++) spawned[0].emit(`line ${i}\n`);
  await wait(30);
  const data = events.filter(event => event.method === 'desktop/terminal-data');
  assert.equal(data.length, 1, 'one burst becomes one message');
  assert.equal(data[0].params.data.split('\n').length - 1, 200);
  spawned[0].emit('bye\n');
  spawned[0].exit(3);
  assert.deepEqual(events.slice(-2).map(event => event.method), ['desktop/terminal-data', 'desktop/terminal-exit']);
  assert.equal(events.at(-1).params.exitCode, 3);
  assert.throws(() => terminals.write(id, 'x'), /has closed/);
});

test('only terminals this service opened can be written to, resized or closed; all close on shutdown', () => {
  const spawned = [];
  const terminals = new Terminals({ emit: () => {}, spawn: fakeSpawn(spawned), env: { SHELL: '/bin/sh' }, platform: 'linux' });
  const a = terminals.open('/p', 80, 24), b = terminals.open('/p', 80, 24);
  terminals.write(a.id, 'ls\r'); terminals.resize(b.id, 120, 40);
  assert.equal(spawned[0].written, 'ls\r');
  assert.deepEqual(spawned[1].size, [120, 40]);
  assert.throws(() => terminals.write('00000000-0000-0000-0000-000000000000', 'rm'), /has closed/);
  assert.throws(() => terminals.write(a.id, 'x'.repeat(64 * 1024 + 1)), /too much/);
  for (let i = 0; i < 6; i++) terminals.open('/p', 80, 24);
  assert.throws(() => terminals.open('/p', 80, 24), /Close a terminal first/);
  terminals.closeAll();
  assert.ok(spawned.every(pty => pty.killed));
});

test('terminal IPC takes only terminal ids, bounded sizes and bounded input', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  validateArguments('openTerminal', ['/w', 80, 24]);
  validateArguments('writeTerminal', [id, 'ls\r']);
  validateArguments('resizeTerminal', [id, 120, 40]);
  validateArguments('closeTerminal', [id]);
  for (const [method, args] of [['openTerminal', ['/w', 0, 24]], ['openTerminal', ['/w', 80.5, 24]], ['writeTerminal', ['not-an-id', 'x']], ['writeTerminal', [id, 5]], ['resizeTerminal', [id, 5000, 24]], ['closeTerminal', []]])
    assert.throws(() => validateArguments(method, args), /Invalid desktop API arguments/, `${method} ${JSON.stringify(args)}`);
});

test('recent output is kept for a reopened view, and dropped once the shell exits', () => {
  const spawned = [];
  const terminals = new Terminals({ emit: () => {}, spawn: fakeSpawn(spawned), env: { SHELL: '/bin/sh' }, platform: 'linux' });
  const { id } = terminals.open('/p', 80, 24);
  spawned[0].emit('$ npm run dev\n');
  spawned[0].emit('ready on :3000\n');
  assert.equal(terminals.history(id), '$ npm run dev\nready on :3000\n');
  spawned[0].emit('x'.repeat(300 * 1024));
  assert.equal(terminals.history(id).length, 256 * 1024, 'history is capped');
  spawned[0].exit(0);
  assert.equal(terminals.history(id), null);
});
