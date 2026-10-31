import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
export const MAX_SERVERS = 6;
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const STDERR_CHARS = 4000;
const SHUTDOWN_MS = 2000;

/**
 * The language servers the editor can use, by kind. TypeScript's ships with
 * Handwork; the others are found on the computer when the person has them.
 */
export const LANGUAGE_SERVERS = Object.freeze({
  typescript: { name: 'TypeScript', bundled: true },
  python: { name: 'Python', commands: [['basedpyright-langserver', '--stdio'], ['pyright-langserver', '--stdio'], ['pylsp']], install: 'Install Pyright (npm install -g pyright) or python-lsp-server (pip install python-lsp-server).' },
  rust: { name: 'Rust', commands: [['rust-analyzer']], install: 'Install rust-analyzer with rustup component add rust-analyzer.' },
  go: { name: 'Go', commands: [['gopls']], install: 'Install gopls with go install golang.org/x/tools/gopls@latest.' },
  c: { name: 'C and C++', commands: [['clangd']], install: 'Install clangd from LLVM or your package manager.' },
  swift: { name: 'Swift', commands: [['sourcekit-lsp']], install: 'Install Xcode or the Swift toolchain.' },
});
export const validLanguageServer = value => typeof value === 'string' && Object.hasOwn(LANGUAGE_SERVERS, value);

/** PATH plus where installers put tools; apps opened from the Dock lack the shell's PATH. */
export function toolDirectories(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const listed = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const common = platform === 'win32'
    ? [path.join(home, '.cargo', 'bin'), path.join(home, 'go', 'bin'), env.APPDATA && path.join(env.APPDATA, 'npm')].filter(Boolean)
    : [path.join(home, '.cargo/bin'), path.join(home, 'go/bin'), path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  return [...new Set([...listed, ...common])];
}

export function findExecutable(name, directories, platform = process.platform) {
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const directory of directories) for (const candidate of names) {
    const file = path.join(directory, candidate);
    try {
      if (!statSync(file).isFile()) continue;
      if (platform !== 'win32') accessSync(file, constants.X_OK);
      return file;
    } catch { /* Not here. */ }
  }
  return null;
}

/** A packaged app keeps these outside the archive, where a child process can run them. */
const unpacked = file => {
  const outside = file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return outside !== file && existsSync(outside) ? outside : file;
};

/** Splits a language server's output into its JSON messages, framed by Content-Length headers. */
export class MessageReader {
  constructor(onMessage) { this.onMessage = onMessage; this.buffer = Buffer.alloc(0); }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.buffer.length > 8192) throw new Error('The language server sent an unreadable header.');
        return;
      }
      const length = Number(/content-length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString('ascii'))?.[1]);
      if (!Number.isSafeInteger(length) || length > MAX_MESSAGE_BYTES) throw new Error('The language server sent an unreadable message.');
      if (this.buffer.length < end + 4 + length) return;
      const body = this.buffer.subarray(end + 4, end + 4 + length).toString('utf8');
      this.buffer = this.buffer.subarray(end + 4 + length);
      this.onMessage(body);
    }
  }
}

export const frame = text => { const body = Buffer.from(text, 'utf8'); return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]); };

/**
 * Language servers for the open project, relayed to the editor as raw LSP
 * messages. The main process decides what runs, where it runs, and the
 * project root the server is told about; the editor only names a kind.
 * Requests a server makes of its client that the editor does not answer
 * (configuration, progress, capability registration) are answered here.
 */
export class LanguageServers {
  constructor({ emit, spawn = nodeSpawn, env = process.env, execPath = process.execPath, platform = process.platform, bundled = null } = {}) {
    this.emit = emit;
    this.spawn = spawn;
    this.env = env;
    this.execPath = execPath;
    this.platform = platform;
    this.bundled = bundled ?? (() => ({
      cli: unpacked(require.resolve('typescript-language-server/lib/cli.mjs')),
      tsserver: unpacked(require.resolve('typescript/lib/tsserver.js')),
    }));
    this.sessions = new Map();
  }

  /** How to run a kind's server, or why it cannot be run. */
  command(kind) {
    const server = LANGUAGE_SERVERS[kind];
    if (server.bundled) {
      const { cli, tsserver } = this.bundled();
      // Electron runs the bundled server as plain Node; its own tsserver child inherits that.
      return { file: this.execPath, args: [cli, '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' }, initializationOptions: { tsserver: { path: tsserver, useSyntaxServer: 'never' } } };
    }
    const directories = toolDirectories(this.env, this.platform);
    for (const [name, ...args] of server.commands) {
      const file = findExecutable(name, directories, this.platform);
      if (file) return { file, args, env: {} };
    }
    throw new Error(`No ${server.name} language server was found. ${server.install}`);
  }

  start(workspace, kind) {
    const key = `${workspace}\0${kind}`;
    // A new editor session starts its own server; the old one belonged to a page that is gone.
    for (const [id, session] of this.sessions) if (session.key === key) this.close(id);
    if (this.sessions.size >= MAX_SERVERS) this.close([...this.sessions.values()].sort((a, b) => a.started - b.started)[0].id);
    const command = this.command(kind);
    const env = { ...this.env, PATH: toolDirectories(this.env, this.platform).join(path.delimiter) };
    for (const name of Object.keys(env)) if (name.startsWith('ELECTRON_') || name === 'NODE_OPTIONS') delete env[name];
    Object.assign(env, command.env);
    const child = this.spawn(command.file, command.args, { cwd: workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const id = randomUUID();
    const session = { id, key, kind, workspace, child, command, stderr: '', started: Date.now(), closed: false };
    this.sessions.set(id, session);
    const reader = new MessageReader(message => this.receive(session, message));
    child.stdout.on('data', chunk => {
      try { reader.push(chunk); } catch (error) { session.stderr += `\n${error.message}`; child.kill(); }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', text => { session.stderr = (session.stderr + text).slice(-STDERR_CHARS); });
    child.stdin.on('error', () => {});
    child.on('error', error => { session.stderr += `\n${error.message}`; this.finish(session, null); });
    child.on('exit', code => this.finish(session, code));
    return { id, name: LANGUAGE_SERVERS[kind].name };
  }

  finish(session, code) {
    if (session.ended) return;
    session.ended = true;
    this.sessions.delete(session.id);
    const detail = session.stderr.trim().split('\n').filter(Boolean).pop()?.slice(0, 300);
    if (!session.closed) this.emit({ method: 'desktop/lsp-exit', params: { id: session.id, code, message: `The ${LANGUAGE_SERVERS[session.kind].name} language server stopped${detail ? `: ${detail}` : '.'}` } });
  }

  send(id, text) {
    const session = this.sessions.get(id);
    if (!session || session.ended) throw new Error('That language server is no longer running.');
    let message;
    try { message = JSON.parse(text); } catch { throw new Error('Language server messages must be JSON.'); }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') throw new Error('Language server messages must be JSON-RPC 2.0.');
    // The project root and the server's options are this process's to choose.
    if (message.method === 'initialize') message.params = this.initializeParams(session, message.params);
    session.child.stdin.write(frame(JSON.stringify(message)));
  }

  initializeParams(session, params) {
    const uri = pathToFileURL(session.workspace).href;
    const capabilities = params?.capabilities && typeof params.capabilities === 'object' ? params.capabilities : {};
    return {
      ...params,
      processId: process.pid,
      rootUri: uri,
      rootPath: session.workspace,
      workspaceFolders: [{ uri, name: path.basename(session.workspace) }],
      initializationOptions: session.command.initializationOptions ?? params?.initializationOptions,
      capabilities: { ...capabilities, workspace: { ...capabilities.workspace, workspaceFolders: true, configuration: true } },
    };
  }

  receive(session, text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    const answer = message && 'id' in message && typeof message.method === 'string' ? this.answer(session, message) : undefined;
    if (answer !== undefined) session.child.stdin.write(frame(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer })));
    else this.emit({ method: 'desktop/lsp-message', params: { id: session.id, message: text } });
  }

  /** Answers for requests the editor's client does not handle; undefined passes the request on. */
  answer(session, message) {
    switch (message.method) {
      // No settings are configured: each server uses its defaults.
      case 'workspace/configuration': return Array.isArray(message.params?.items) ? message.params.items.map(() => null) : [];
      case 'workspace/workspaceFolders': return [{ uri: pathToFileURL(session.workspace).href, name: path.basename(session.workspace) }];
      case 'window/workDoneProgress/create': case 'client/registerCapability': case 'client/unregisterCapability': return null;
      default: return undefined;
    }
  }

  /** Ask the server to shut down, then make sure it has. */
  close(id) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.closed = true;
    this.sessions.delete(id);
    try {
      session.child.stdin.write(frame(JSON.stringify({ jsonrpc: '2.0', id: 'handwork-shutdown', method: 'shutdown' })));
      session.child.stdin.write(frame(JSON.stringify({ jsonrpc: '2.0', method: 'exit' })));
      session.child.stdin.end();
    } catch { /* Already gone. */ }
    const timer = setTimeout(() => { try { session.child.kill(); } catch { /* Already gone. */ } }, SHUTDOWN_MS);
    timer.unref?.();
  }

  closeAll() { for (const id of [...this.sessions.keys()]) this.close(id); }
}
