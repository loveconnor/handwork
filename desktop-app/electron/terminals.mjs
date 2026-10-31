import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const MAX_TERMINALS = 8;
// Output is gathered for a moment before it is sent, so a burst (a build log,
// `ls -R`) crosses to the window as a few messages rather than thousands.
const FLUSH_MS = 8;
const MAX_WRITE = 64 * 1024;
// Recent output is kept so a view reopened later picks up where the shell is.
const HISTORY_CHARS = 256 * 1024;

/** The person's own shell, as a login shell so their PATH and aliases load like Terminal's. */
export function defaultShell(env = process.env, platform = process.platform) {
  if (platform === 'win32') return { file: env.COMSPEC && /powershell|pwsh/i.test(env.COMSPEC) ? env.COMSPEC : 'powershell.exe', args: ['-NoLogo'] };
  const file = [env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].find(candidate => candidate && path.isAbsolute(candidate) && existsSync(candidate));
  return { file, args: ['-l'] };
}

/**
 * Shells for the workbench. Each runs in the open project's folder; the window
 * can only write to, resize, or close terminals this service started, by id.
 */
export class Terminals {
  constructor({ emit, spawn, env = process.env, platform = process.platform }) {
    this.emit = emit;
    this.spawn = spawn;
    this.env = env;
    this.platform = platform;
    this.sessions = new Map();
  }

  open(cwd, cols, rows) {
    if (this.sessions.size >= MAX_TERMINALS) throw new Error(`Close a terminal first: Handwork keeps up to ${MAX_TERMINALS} open.`);
    const shell = defaultShell(this.env, this.platform);
    if (!shell.file) throw new Error('No shell was found on this computer.');
    // Electron's own switches must not leak into the person's shell.
    const env = { ...this.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Handwork' };
    for (const key of Object.keys(env)) if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') delete env[key];
    const pty = this.spawn(shell.file, shell.args, { name: 'xterm-256color', cols, rows, cwd: cwd || this.env.HOME || homedir(), env });
    const id = randomUUID();
    const session = { pty, buffer: '', timer: null, history: '' };
    this.sessions.set(id, session);
    pty.onData(data => {
      session.buffer += data;
      session.history = (session.history + data).slice(-HISTORY_CHARS);
      session.timer ??= setTimeout(() => this.flush(id), FLUSH_MS);
    });
    pty.onExit(({ exitCode }) => {
      this.flush(id);
      this.sessions.delete(id);
      this.emit({ method: 'desktop/terminal-exit', params: { id, exitCode } });
    });
    return { id, shell: path.basename(shell.file) };
  }

  flush(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    session.timer = null;
    if (!session.buffer) return;
    const data = session.buffer;
    session.buffer = '';
    this.emit({ method: 'desktop/terminal-data', params: { id, data } });
  }

  session(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('That terminal has closed.');
    return session;
  }

  write(id, data) {
    if (data.length > MAX_WRITE) throw new Error('That is too much to paste into a terminal at once.');
    this.session(id).pty.write(data);
  }

  resize(id, cols, rows) { this.session(id).pty.resize(cols, rows); }

  /** What a reattached view should show first; null once the terminal has closed. */
  history(id) { return this.sessions.get(id)?.history ?? null; }

  close(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.timer);
    this.sessions.delete(id);
    try { session.pty.kill(); } catch { /* It may already have exited. */ }
  }

  closeAll() { for (const id of [...this.sessions.keys()]) this.close(id); }
}
