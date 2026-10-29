import { LSPClient, LSPPlugin, Workspace, formatKeymap, hoverTooltips, jumpToDefinition, jumpToDefinitionKeymap, serverCompletion, serverDiagnostics, signatureHelp, type Transport, type WorkspaceFile } from '@codemirror/lsp-client';
import { ChangeSet, Prec, Text, type Extension } from '@codemirror/state';
import { EditorView, keymap, showDialog, type Command } from '@codemirror/view';
import type { DesktopAPI, LanguageServerKind, ProjectSearchMatch } from '@/lib/desktop-api';
import { applyTextEdits, editsByUri, fileUri, languageServerFor, matchPreview, projectPath, sanitizeDocs, uriKey, type TextEdit } from '@/lib/language-servers';
import { editorLint } from './editorLint';

/**
 * Language servers for the workbench's editors: one per language per
 * project, started the first time a file of that language opens. Files whose
 * language has no server, or whose server is missing, keep the syntax check.
 */
export type ServerStatus = { state: 'starting' | 'ready' | 'unavailable' | 'stopped' | 'off'; name: string; message?: string; progress?: string };
export type LanguageHooks = {
  /** Show a project file in the focused editor. */
  open(path: string): void;
  /** Change a file no editor is showing: its open tab's text if it has one, else the file on disk. */
  edit(path: string, change: (text: string) => string): Promise<void>;
  /** List where a symbol is used, beside the files. */
  references(symbol: string, matches: ProjectSearchMatch[]): void;
};

const NAMES: Record<LanguageServerKind, string> = { typescript: 'TypeScript', python: 'Python', rust: 'Rust', go: 'Go', c: 'C and C++', swift: 'Swift' };
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const cleanError = (cause: unknown) => (cause instanceof Error ? cause.message : typeof cause === 'object' && cause && 'message' in cause ? String((cause as { message: unknown }).message) : String(cause)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
/** How long a jump to another file waits for its editor to open. */
const DISPLAY_TIMEOUT_MS = 8000;

type WorkspaceFileUpdate = ReturnType<Workspace['syncFiles']>[number];

class ProjectFile implements WorkspaceFile {
  views: EditorView[];
  constructor(readonly uri: string, readonly languageId: string, public version: number, public doc: Text, view: EditorView) { this.views = [view]; }
  getView(main?: EditorView) { return main && this.views.includes(main) ? main : this.views[0] ?? null; }
}

/**
 * The files the server knows are open: those shown in an editor. A file can
 * be shown in several panes at once; the first is the one changes are read
 * from. Files opened elsewhere by the server (references, definitions) are
 * read from disk or shown through the workbench.
 */
class ProjectWorkspace extends Workspace {
  files: ProjectFile[] = [];
  private versions = new Map<string, number>();
  private waiting = new Map<string, ((view: EditorView | null) => void)[]>();
  constructor(client: LSPClient, private support: LanguageSupport) { super(client); }

  getFile(uri: string) { const key = uriKey(uri); return this.files.find(file => uriKey(file.uri) === key) ?? null; }
  private nextVersion(uri: string) { const version = (this.versions.get(uriKey(uri)) ?? -1) + 1; this.versions.set(uriKey(uri), version); return version; }

  syncFiles() {
    const updates: WorkspaceFileUpdate[] = [];
    for (const file of this.files) {
      const view = file.getView(), plugin = view && LSPPlugin.get(view);
      if (!view || !plugin) continue;
      const doc = view.state.doc;
      if (!doc.eq(file.doc)) {
        // The view's own record of edits is exact when it last synced this same text; otherwise the whole file is sent.
        const changes = !plugin.unsyncedChanges.empty && plugin.syncedDoc.eq(file.doc) ? plugin.unsyncedChanges : ChangeSet.of({ from: 0, to: file.doc.length, insert: doc }, file.doc.length);
        updates.push({ file, prevDoc: file.doc, changes });
        file.doc = doc;
        file.version = this.nextVersion(file.uri);
      }
      for (const other of file.views) LSPPlugin.get(other)?.clear();
    }
    return updates;
  }

  openFile(uri: string, languageId: string, view: EditorView) {
    const file = this.getFile(uri);
    if (file) { if (!file.views.includes(view)) file.views.push(view); }
    else {
      const opened = new ProjectFile(uri, languageId, this.nextVersion(uri), view.state.doc, view);
      this.files.push(opened);
      this.client.didOpen(opened);
    }
    const key = uriKey(uri);
    for (const resolve of this.waiting.get(key) ?? []) resolve(view);
    this.waiting.delete(key);
  }

  closeFile(uri: string, view: EditorView) {
    const file = this.getFile(uri);
    if (!file) return;
    file.views = file.views.filter(item => item !== view);
    if (file.views.length) return;
    this.files = this.files.filter(item => item !== file);
    this.client.didClose(file.uri);
  }

  /** A file the server points at but no editor shows, read from disk for the references list. */
  async requestFile(uri: string): Promise<WorkspaceFile | null> {
    const open = this.getFile(uri);
    if (open) return open;
    const path = projectPath(uri, this.support.workspace);
    if (!path) return null;
    try {
      const read = await this.support.api.readProjectFile(this.support.workspace, path);
      if (read.text === null) return null;
      return { uri, languageId: languageServerFor(path)?.languageId ?? '', version: 0, doc: Text.of(read.text.split(/\r\n?|\n/)), getView: () => null };
    } catch { return null; }
  }

  displayFile(uri: string): Promise<EditorView | null> {
    const path = projectPath(uri, this.support.workspace);
    // Files outside the project, such as a library's type definitions, are not opened here.
    if (!path) return Promise.resolve(null);
    this.support.hooks.open(path);
    const shown = this.getFile(uri)?.getView();
    if (shown) return Promise.resolve(shown);
    return new Promise(resolve => {
      const key = uriKey(uri);
      const timer = setTimeout(() => { this.waiting.set(key, (this.waiting.get(key) ?? []).filter(item => item !== done)); resolve(null); }, DISPLAY_TIMEOUT_MS);
      const done = (view: EditorView | null) => { clearTimeout(timer); resolve(view); };
      this.waiting.set(key, [...(this.waiting.get(key) ?? []), done]);
    });
  }
}

type Server = { kind: LanguageServerKind; generation: number; id?: string; client: LSPClient | null; status: ServerStatus; ready: Promise<LSPClient | null>; handlers: Set<(message: string) => void>; progress: Map<string | number, string> };

export class LanguageSupport {
  private servers = new Map<LanguageServerKind, Server>();
  private extensions = new Map<string, Promise<Extension>>();
  private listeners = new Set<() => void>();
  private off: () => void;

  constructor(readonly api: DesktopAPI, readonly workspace: string, readonly hooks: LanguageHooks) {
    this.off = api.onEvent(event => {
      const params = event.params as { id?: string; message?: string } | undefined;
      if (!params?.id || !event.method.startsWith('desktop/lsp-')) return;
      const server = [...this.servers.values()].find(item => item.id === params.id);
      if (!server) return;
      if (event.method === 'desktop/lsp-message' && typeof params.message === 'string') for (const handler of server.handlers) handler(params.message);
      if (event.method === 'desktop/lsp-exit') this.stopped(server, params.message);
    });
  }

  /** Editor support for a file: its language server when there is one, else the syntax check. */
  support(path: string): Promise<Extension> {
    const target = languageServerFor(path);
    if (!target) return Promise.resolve(editorLint(path));
    const server = this.server(target.kind);
    // The same extension object for the same file keeps a reconfigure from restarting its plugin.
    const key = `${target.kind}\0${server.generation}\0${path}`;
    let extension = this.extensions.get(key);
    if (!extension) {
      extension = server.ready.then(client => client ? this.editorExtension(client, path, target.languageId) : editorLint(path));
      this.extensions.set(key, extension);
    }
    return extension;
  }

  status(path: string): ServerStatus | null {
    const target = languageServerFor(path);
    return target ? this.servers.get(target.kind)?.status ?? null : null;
  }

  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify() { for (const listener of this.listeners) listener(); }

  /** Stop a language's server and start it again; open editors reconnect to the new one. */
  restart(path: string) {
    const target = languageServerFor(path);
    const old = target && this.servers.get(target.kind);
    if (!target || !old) return;
    this.shutdown(old);
    this.servers.delete(target.kind);
    this.server(target.kind, old.generation + 1);
    this.notify();
  }

  dispose() {
    this.off();
    for (const server of this.servers.values()) this.shutdown(server);
    this.servers.clear();
    this.listeners.clear();
  }

  private shutdown(server: Server) {
    server.status = { ...server.status, state: 'stopped' };
    server.client?.disconnect();
    if (server.id) void this.api.lspStop(server.id).catch(() => {});
  }

  private stopped(server: Server, message?: string) {
    if (server.status.state === 'stopped') return;
    server.status = { state: 'stopped', name: server.status.name, message };
    server.client?.disconnect();
    this.notify();
  }

  private server(kind: LanguageServerKind, generation = 0): Server {
    const existing = this.servers.get(kind);
    if (existing) return existing;
    const server: Server = { kind, generation, client: null, status: { state: 'starting', name: NAMES[kind] }, handlers: new Set(), progress: new Map(), ready: Promise.resolve(null) };
    this.servers.set(kind, server);
    server.ready = this.connect(server);
    return server;
  }

  private async connect(server: Server): Promise<LSPClient | null> {
    try {
      const { id, name } = await this.api.lspStart(this.workspace, server.kind);
      server.id = id;
      server.status = { state: 'starting', name };
      this.notify();
      const transport: Transport = {
        // Messages for a server that has stopped are dropped; restarting replays the open files.
        send: message => { if (server.status.state !== 'stopped') void this.api.lspSend(id, message).catch(() => {}); },
        subscribe: handler => { server.handlers.add(handler); },
        unsubscribe: handler => { server.handlers.delete(handler); },
      };
      const client = new LSPClient({
        rootUri: fileUri(this.workspace),
        // A server's first answers wait for it to load the project.
        timeout: 20000,
        sanitizeHTML: sanitizeDocs,
        workspace: client => new ProjectWorkspace(client, this),
        notificationHandlers: {
          // Server chatter is for its log, not for dialogs over the code.
          'window/showMessage': (_client, params: { type: number; message: string }) => { if (params.type <= 2) console.warn(`[${name}] ${params.message}`); return true; },
          'window/logMessage': () => true,
          '$/progress': (_client, params: { token: string | number; value?: { kind: string; title?: string; message?: string } }) => this.progress(server, params),
        },
        extensions: [serverCompletion({ override: true }), hoverTooltips(), signatureHelp(), serverDiagnostics()],
      });
      client.connect(transport);
      await client.initializing;
      if (server.status.state === 'stopped') return null;
      server.client = client;
      server.status = { state: 'ready', name };
      this.notify();
      return client;
    } catch (cause) {
      const message = cleanError(cause);
      if (server.status.state !== 'stopped') server.status = { state: /turned off/.test(message) ? 'off' : 'unavailable', name: server.status.name, message };
      if (server.id) void this.api.lspStop(server.id).catch(() => {});
      this.notify();
      return null;
    }
  }

  /** What the server is busy with, such as indexing, for the editor's status. */
  private progress(server: Server, params: { token: string | number; value?: { kind: string; title?: string; message?: string } }) {
    const { token, value } = params;
    if (value?.kind === 'begin') server.progress.set(token, value.title ?? '');
    else if (value?.kind === 'end') server.progress.delete(token);
    const current = [...server.progress.values()].filter(Boolean).pop();
    if (current !== server.status.progress) { server.status = { ...server.status, progress: current }; this.notify(); }
    return true;
  }

  private absolute(path: string) {
    const separator = this.workspace.includes('\\') && !this.workspace.includes('/') ? '\\' : '/';
    return `${this.workspace.replace(/[\\/]+$/, '')}${separator}${path.split('/').join(separator)}`;
  }

  private editorExtension(client: LSPClient, path: string, languageId: string): Extension {
    return [
      client.plugin(fileUri(this.absolute(path)), languageId),
      Prec.high(keymap.of([...jumpToDefinitionKeymap, ...formatKeymap, { key: 'F2', run: this.renameCommand, preventDefault: true }, { key: 'Shift-F12', run: this.referencesCommand, preventDefault: true }])),
      // ⌘-click (Ctrl-click) goes to a definition, as in other editors; Alt-click adds a cursor instead.
      EditorView.clickAddsSelectionRange.of(event => event.altKey),
      EditorView.domEventHandlers({
        mousedown: (event, view) => {
          if (event.button !== 0 || !(isMac ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey) return false;
          const pos = view.posAtCoords(event);
          if (pos === null) return false;
          event.preventDefault();
          view.dispatch({ selection: { anchor: pos } });
          jumpToDefinition(view);
          return true;
        },
      }),
    ];
  }

  /**
   * Where the symbol at the cursor is used, listed in the workbench like
   * search results. The library's own panel cannot show files no editor has open.
   */
  private referencesCommand: Command = view => {
    const plugin = LSPPlugin.get(view);
    const head = view.state.selection.main.head;
    const word = view.state.wordAt(head);
    if (!plugin || !plugin.client.serverCapabilities?.referencesProvider) return false;
    plugin.client.sync();
    type Location = { uri: string; range: TextEdit['range'] };
    void plugin.client.request<unknown, Location[] | null>('textDocument/references', { textDocument: { uri: plugin.uri }, position: plugin.toPosition(head), context: { includeDeclaration: true } }).then(async locations => {
      const matches: ProjectSearchMatch[] = [];
      for (const location of locations ?? []) {
        const path = projectPath(location.uri, this.workspace);
        const file = path && await plugin.client.workspace.requestFile(location.uri);
        if (!path || !file) continue;
        const doc = file.getView()?.state.doc ?? file.doc;
        const { start, end } = location.range;
        if (start.line >= doc.lines) continue;
        const text = doc.line(start.line + 1).text;
        const length = end.line === start.line ? end.character - start.character : text.length - start.character;
        matches.push({ path, line: start.line + 1, column: start.character + 1, length, ...matchPreview(text, start.character) });
      }
      this.hooks.references(word ? view.state.sliceDoc(word.from, word.to) : 'symbol', matches);
    }, error => plugin.reportError('Finding references failed', error));
    return true;
  };

  /**
   * Rename the symbol at the cursor everywhere the server says it is used,
   * including files no editor has open, which the library's own rename skips.
   */
  private renameCommand: Command = view => {
    const plugin = LSPPlugin.get(view);
    const word = view.state.wordAt(view.state.selection.main.head);
    if (!plugin || !word || !plugin.client.serverCapabilities?.renameProvider) return false;
    const current = view.state.sliceDoc(word.from, word.to);
    const { close, result } = showDialog(view, { label: 'Rename to', input: { name: 'name', value: current, spellcheck: 'false' }, focus: true, submitLabel: 'Rename', class: 'cm-lsp-rename-panel' });
    void result.then(form => {
      view.dispatch({ effects: close });
      const name = (form?.elements.namedItem('name') as HTMLInputElement | null)?.value.trim();
      if (name && name !== current) void this.rename(view, word.from, name);
    });
    return true;
  };

  private async rename(view: EditorView, pos: number, newName: string) {
    const plugin = LSPPlugin.get(view);
    if (!plugin) return;
    const client = plugin.client;
    client.sync();
    try {
      await client.withMapping(async mapping => {
        const edit = await client.request<unknown, Parameters<typeof editsByUri>[0]>('textDocument/rename', { textDocument: { uri: plugin.uri }, position: plugin.toPosition(pos), newName });
        const failures: string[] = [];
        for (const [uri, edits] of editsByUri(edit)) {
          const target = client.workspace.getFile(uri)?.getView();
          if (target && mapping.getMapping(uri)) {
            target.dispatch({ changes: edits.map((change: TextEdit) => ({ from: mapping.mapPosition(uri, change.range.start), to: mapping.mapPosition(uri, change.range.end), insert: change.newText })), userEvent: 'rename' });
            continue;
          }
          const path = projectPath(uri, this.workspace);
          if (!path) continue;
          try { await this.hooks.edit(path, text => applyTextEdits(text, edits)); }
          catch (cause) { failures.push(`${path}: ${cleanError(cause)}`); }
        }
        if (failures.length) plugin.reportError('Some files were not renamed', new Error(failures.join('; ')));
      });
    } catch (cause) { plugin.reportError('Rename failed', cause); }
  }
}
