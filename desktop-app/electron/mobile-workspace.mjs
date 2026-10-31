import path from 'node:path';
import { hostname } from 'node:os';
import { realpath, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { attachments as validAttachments } from './ipc.mjs';
import { ProjectChangesReader } from './project-changes.mjs';
const projectId = directory => `project:${createHash('sha256').update(directory).digest('hex').slice(0, 24)}`;
const CHAT_ID = 'handwork:chats';
const flatten = values => (values ?? []).flatMap(v => v.options ? flatten(v.options) : [v]);
const optionsFor = engine => engine?.session?.configOptions ?? [];
const valueOf = (options, id) => options.find(v => v.id === id)?.currentValue ?? '';
const modelId = (provider, model) => JSON.stringify([provider, model]);

export function mobileTurns(updates, busy = false) {
  const turns = []; let turn; let lastKind;
  for (const update of updates) {
    const kind = update.sessionUpdate;
    if (!['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(kind)) continue;
    if (!turn || (kind === 'user_message_chunk' && (lastKind !== kind || (update.messageId && update.messageId !== turn.userMessageId)))) {
      turn = { id: `turn-${turns.length}`, items: [], copyText: '', userMessageId: update.messageId }; turns.push(turn);
    }
    const text = update.content?.type === 'text' ? update.content.text : '';
    if (kind === 'user_message_chunk' || kind === 'agent_message_chunk') {
      const type = kind === 'user_message_chunk' ? 'user' : 'text';
      let item = turn.items.at(-1);
      if (!item || item.type !== type) { item = { type, id: `${turn.id}-${turn.items.length}`, text: '' }; turn.items.push(item); }
      item.text += text || '';
      if (type === 'user' && update.content?.type === 'image') item.attachments = (item.attachments ?? 0) + 1;
      if (type === 'text') turn.copyText += text || '';
    } else if (kind === 'tool_call') {
      turn.items.push({ type: 'notice', id: `${turn.id}-${turn.items.length}`, text: update.title || 'Working…' });
    }
    lastKind = kind;
  }
  return turns.map(({ userMessageId: _, ...turn }, i) => ({ ...turn, footer: !(busy && i === turns.length - 1), items: turn.items.map(item => item.type === 'text' ? { ...item, streaming: busy && i === turns.length - 1 } : item) }));
}

/** Adapts the existing phone protocol to the same engine and stores the Electron UI uses. */
export class MobileWorkspace {
  constructor(backend) {
    this.backend = backend; this.live = new Map(); this.errors = new Map(); this.pendingPermissions = new Map(); this.lastRefresh = 0;
    this.listener = event => {
      const id = event.params?.sessionId; if (!id) return;
      if (event.method === 'session/request_permission') this.pendingPermissions.set(id, event);
      if (event.method === 'session/update' && this.live.has(id)) this.live.get(id).push(event.params.update);
    };
    backend.on('event', this.listener);
  }
  dispose() { this.backend.off('event', this.listener); }
  engine(id) { return [...this.backend.engines].find(v => v.session?.sessionId === id && !v.client.closed); }
  projects() {
    return [{ id: CHAT_ID, kind: 'chats', name: 'Chats', path: '', machine: hostname(), branch: '', color: '#8b8b8b', additions: 0, deletions: 0, defaultHarness: 'handwork' }, ...this.backend.projects.list().map(directory => ({ id: projectId(directory), name: path.basename(directory), path: directory, machine: hostname(), branch: '', color: '#8b8b8b', additions: 0, deletions: 0, defaultHarness: 'handwork' }))];
  }
  project(id) { const found = this.projects().find(p => p.id === id); if (!found) throw new Error('This workspace item is no longer available'); return found; }
  async catalog() {
    const b = this.backend;
    if (Date.now() - this.lastRefresh > 5000) {
      this.lastRefresh = Date.now(); await b.listSessions();
    }
    const known = new Map(b.listCachedSessions().sessions.map(s => [s.sessionId, s]));
    for (const e of b.engines) if (e.session && !known.has(e.session.sessionId)) known.set(e.session.sessionId, { sessionId: e.session.sessionId, cwd: e.workspace, updatedAt: e.mobileStartedAt ??= new Date().toISOString() });
    const preferences = b.chatPreferences?.list() ?? {};
    for (const [id, session] of known) {
      const preference = preferences[id] ?? {};
      known.set(id, { ...session, title: preference.title || preference.generatedTitle || session.title, archived: preference.archived ?? session.archived });
    }
    const projects = this.projects();
    const sessions = [...known.values()].filter(s => !s.archived).flatMap(s => {
      const project = projects.find(p => p.path === s.cwd); if (!project) return [];
      const engine = this.engine(s.sessionId); const options = optionsFor(engine);
      return [{ id: s.sessionId, projectId: project.id, title: s.title || 'New chat', harness: 'handwork', model: modelId(valueOf(options, 'provider'), valueOf(options, 'model')), modelName: valueOf(options, 'model'), branch: '', runtimeMode: valueOf(options, 'mode') === 'code' ? 'full-access' : 'supervised', updatedAt: Number(s.updatedAt) || Date.parse(s.updatedAt) || Date.now(), busy: !!engine?.prompting }];
    }).sort((a, b) => b.updatedAt - a.updatedAt);
    return { projects, monos: [], sessions };
  }
  async known(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(id)) throw new Error('Invalid conversation ID');
    const catalog = await this.catalog();
    if (!catalog.sessions.some(s => s.id === id)) throw new Error('This workspace item is no longer available');
    return id;
  }
  async retain(id) {
    await this.known(id);
    if (!this.engine(id)) await this.backend.loadSession(id, false);
    if (!this.live.has(id)) { const history = await this.backend.readSession(id); this.live.set(id, history.updates ?? []); }
    return this.engine(id);
  }
  async read(id, window = {}) {
    await this.known(id);
    const busy = !!this.engine(id)?.prompting;
    // History is read through the engine's read-only API; streamed events extend it in memory.
    if (!this.live.has(id) || !busy) this.live.set(id, (await this.backend.readSession(id)).updates ?? []);
    const all = mobileTurns(this.live.get(id), busy);
    const end = window.before ? Math.max(0, all.findIndex(t => t.id === window.before)) : all.length;
    const from = window.from ? all.findIndex(t => t.id === window.from) : -1;
    const count = Math.max(1, Math.min(200, Math.trunc(Number(window.tail ?? window.limit) || 200)));
    const start = from >= 0 ? from : Math.max(0, end - count);
    const turns = all.slice(start, end);
    const error = this.errors.get(id);
    if (error) turns.push({ id: 'mobile-error', items: [{ type: 'notice', id: 'mobile-error', text: error, error: true }] });
    return { turns, busy, older: start > 0, messages: turns.flatMap(t => t.items.filter(i => i.type === 'user' || i.type === 'text').map(i => ({ id: i.id, role: i.type === 'user' ? 'user' : 'assistant', text: i.text }))) };
  }
  prompt(id, params) {
    if (typeof params.text !== 'string' || Buffer.byteLength(params.text) > 1024 * 1024 || params.text.includes('\0') || !validAttachments(params.attachments ?? [])) throw new Error('Invalid message or attachment size');
    const engine = this.engine(id); if (!engine || engine.running) throw new Error('Handwork is busy');
    if (!params.text.trim() && !params.attachments?.length) throw new Error('Nothing to send');
    this.errors.delete(id);
    // The user chunk is emitted by the engine; do not insert a second local copy.
    void this.backend.prompt(params.text, params.attachments ?? [], id).catch(error => this.errors.set(id, error.message));
    return { accepted: true };
  }
  async configure(id, p) {
    if (p.harness && p.harness !== 'handwork') throw new Error('Choose a Handwork model for this desktop');
    if (p.providerAccountId) throw new Error('Manage provider accounts in Electron Settings → Models & providers');
    await this.retain(id);
    if (p.model) {
      let choice; try { choice = JSON.parse(p.model); } catch { throw new Error('Choose a model from this desktop'); }
      if (!Array.isArray(choice) || choice.length !== 2 || !choice.every(v => typeof v === 'string')) throw new Error('Invalid model');
      await this.backend.setConfig('provider', choice[0], id); await this.backend.setConfig('model', choice[1], id);
    }
    if (p.runtimeMode) {
      if (!['supervised', 'full-access'].includes(p.runtimeMode)) throw new Error('This desktop supports supervised or full access mode');
      await this.backend.setConfig('mode', p.runtimeMode === 'full-access' ? 'code' : 'ask', id);
    }
    for (const [key, value] of Object.entries(p.modelSettings ?? {})) {
      if (!['effort', 'fast_mode', 'thinking'].includes(key) || typeof value !== 'string') throw new Error('Unsupported model setting');
      await this.backend.setConfig(key, value, id);
    }
    return { accepted: true };
  }
  async models(p) {
    this.project(p.projectId);
    const engine = p.conversationId ? await this.retain(p.conversationId) : null;
    const providers = await this.backend.listProviders(); const models = [];
    for (const provider of providers.providers ?? []) {
      if (!provider.connected) continue;
      const result = await this.backend.providerModels(provider.id);
      for (const model of flatten(result.configOptions?.find(v => v.id === 'model')?.options)) models.push({ id: modelId(provider.id, model.value), harness: 'handwork', provider: provider.name ?? provider.id, name: model.name ?? model.id, settings: [] });
    }
    const options = optionsFor(engine);
    return { harnesses: [{ id: 'handwork', label: 'Handwork' }], models, accounts: [], runtimeModes: [{ id: 'supervised', label: 'Supervised', hint: 'Approve tools on desktop' }, { id: 'full-access', label: 'Full access', hint: 'Allow the agent to act without asking' }], current: { harness: 'handwork', model: engine ? modelId(valueOf(options, 'provider'), valueOf(options, 'model')) : models[0]?.id ?? '', modelSettings: {}, runtimeMode: valueOf(options, 'mode') === 'code' ? 'full-access' : 'supervised' } };
  }
  async fileTarget(p) {
    const project = this.project(p.projectId); if (!project.path) throw new Error('Chats do not have project files');
    if (p.worktreePath && p.worktreePath !== project.path) throw new Error('Add this worktree as a project in desktop first');
    const root = await realpath(project.path);
    if (typeof (p.path ?? '') !== 'string' || (p.path ?? '').includes('\0')) throw new Error('Invalid file path');
    const file = await realpath(path.resolve(root, p.path ?? ''));
    if (file !== root && !file.startsWith(root + path.sep)) throw new Error('File is outside the project');
    return { root, file };
  }
  async handle(method, p) {
    switch (method) {
      case 'workspace.list': return this.catalog();
      case 'sessions.list': {
        this.project(p.projectId); const query = String(p.query ?? '').toLowerCase();
        const all = (await this.catalog()).sessions.filter(s => s.projectId === p.projectId && (!p.since || s.updatedAt >= p.since) && !(p.hiddenHarnesses ?? []).includes(s.harness) && `${s.title} ${s.model}`.toLowerCase().includes(query));
        const offset = Math.max(0, Math.trunc(Number(p.offset) || 0)), limit = Math.max(1, Math.min(100, Math.trunc(Number(p.limit) || 30)));
        return { sessions: all.slice(offset, offset + limit), hasMore: offset + limit < all.length };
      }
      case 'conversation.read': return this.read(p.conversationId, p);
      case 'conversation.older': return this.read(p.conversationId, { before: p.before, limit: p.limit ?? 30 });
      case 'conversation.send': await this.retain(p.conversationId); return this.prompt(p.conversationId, p);
      case 'session.start': {
        const project = this.project(p.projectId);
        if (p.workspaceMode || p.worktreePath) throw new Error('Add the working copy as a project in desktop first');
        const session = await this.backend.exclusive(async () => {
          const previous = this.backend.workspace; this.backend.workspace = project.path;
          try { return await this.backend.createSession(!project.path, false); } finally { this.backend.workspace = previous; }
        });
        this.live.set(session.sessionId, []);
        await this.configure(session.sessionId, p);
        this.prompt(session.sessionId, p); return { sessionId: session.sessionId };
      }
      case 'session.configure': return this.configure(p.conversationId, p);
      case 'session.cancel': await this.known(p.conversationId); await this.backend.cancel(p.conversationId); return { accepted: true };
      case 'session.rename': await this.known(p.conversationId); if (typeof p.title !== 'string' || !p.title.trim() || p.title.length > 200 || /[\r\n\0]/.test(p.title)) throw new Error('Invalid title'); return this.backend.updateChat(p.conversationId, { title: p.title.trim() });
      case 'session.archive': await this.known(p.conversationId); return this.backend.updateChat(p.conversationId, { archived: true });
      case 'session.delete': await this.known(p.conversationId); await this.backend.deleteSession(p.conversationId); this.live.delete(p.conversationId); return { accepted: true };
      case 'models.list': return this.models(p);
      case 'accounts.usage': return { accounts: [] };
      case 'project.search': {
        const { root } = await this.fileTarget({ ...p, path: '' });
        const query = String(p.query ?? '').trim().toLowerCase(); if (!query || query.length > 200) return { results: [] };
        const folders = ['']; const results = []; let scanned = 0;
        while (folders.length && results.length < 100 && scanned < 10000) {
          const folder = folders.shift();
          for (const entry of await readdir(path.join(root, folder), { withFileTypes: true }).catch(() => [])) {
            if (++scanned > 10000 || results.length >= 100) break;
            if (['.git', 'node_modules', 'target'].includes(entry.name) || entry.isSymbolicLink()) continue;
            const relative = path.join(folder, entry.name);
            if (entry.isDirectory()) folders.push(relative);
            else if (relative.toLowerCase().includes(query)) results.push({ path: relative, name: entry.name });
          }
        }
        return { results };
      }
      case 'project.git': {
        const { root } = await this.fileTarget({ ...p, path: '' }); const state = await this.backend.gitState(root);
        return { branch: state.head?.branch ?? '', files: state.totalFiles ?? 0, remote: !!state.remotes?.length, upstream: !!state.upstream, defaultBranch: '', ahead: state.ahead ?? 0, behind: state.behind ?? 0, aheadOfDefault: 0, canGenerate: !!this.backend.session, pr: null };
      }
      case 'project.gitAction': {
        const { root } = await this.fileTarget({ ...p, path: '' }); let result;
        if (['stage', 'unstage'].includes(p.action)) {
          if (!Array.isArray(p.paths) || !p.paths.length || p.paths.length > 1000 || p.paths.some(v => typeof v !== 'string' || path.isAbsolute(v) || v.split(/[\\/]/).includes('..') || /[\x00-\x1f]/.test(v))) throw new Error('Invalid file paths');
          result = await this.backend[p.action === 'stage' ? 'gitStage' : 'gitUnstage'](root, p.paths);
        } else if (p.action === 'stageAll' || p.action === 'unstageAll') result = await this.backend[p.action === 'stageAll' ? 'gitStageAll' : 'gitUnstageAll'](root);
        else if (p.action === 'generate') { const generated = await this.backend.gitCommitMessage(root); return { message: [generated.summary, generated.description].filter(Boolean).join('\n\n') }; }
        else if (p.action === 'commit') {
          if (typeof p.message !== 'string' || !p.message.trim() || p.message.length > 65536 || p.message.includes('\0')) throw new Error('Invalid commit message');
          const state = await this.backend.gitState(root); const [summary, ...body] = p.message.trim().split('\n');
          result = await this.backend.gitCommit(root, { summary, description: body.join('\n').trim() }, { repository: state.repository, branch: state.head.branch, head: state.head.oid, index: state.index });
        } else throw new Error('Use desktop Source Control for sync and pull requests');
        if (result?.ok === false) throw new Error(result.error?.message || result.error?.title || 'Git action failed'); return { accepted: true };
      }
      case 'project.worktrees': this.project(p.projectId); return { worktrees: [] };
      case 'project.files': { const { file } = await this.fileTarget(p); const entries = await readdir(file, { withFileTypes: true }); return { entries: entries.filter(e => e.name !== '.git').slice(0, 2000).map(e => ({ name: e.name, isDir: e.isDirectory(), ignored: false })) }; }
      case 'project.file': {
        const { file } = await this.fileTarget(p); const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { if (!(await handle.stat()).isFile()) throw new Error('Not a regular file'); const buffer = Buffer.alloc(1024 * 1024 + 1); const { bytesRead } = await handle.read(buffer); const bytes = buffer.subarray(0, Math.min(bytesRead, 1024 * 1024)); if (bytes.includes(0)) throw new Error('Binary file'); return { path: p.path, text: bytes.toString('utf8'), truncated: bytesRead > 1024 * 1024 }; } finally { await handle.close(); }
      }
      case 'project.changes': {
        const { root } = await this.fileTarget({ ...p, path: '' }); const reader = new ProjectChangesReader(); const snapshot = await reader.snapshot(root);
        const files = [];
        for (const f of snapshot.files.slice(0, 100)) {
          const diff = await reader.file(root, f.path); const lines = diff.sections.flatMap(section => (section.patch ?? section.text ?? section.note ?? '').split('\n').map(text => ({ kind: text.startsWith('@@') ? 'hunk' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : 'context', text, oldNumber: null, newNumber: null })));
          files.push({ relative: f.path, status: f.untracked ? 'untracked' : f.status.includes('D') ? 'deleted' : f.status.includes('A') ? 'added' : 'modified', additions: f.added, deletions: f.removed, staged: f.staged, unstaged: f.unstaged, lines });
        }
        return { branch: '', files };
      }
      default: throw new Error(`This Electron desktop does not support ${method}`);
    }
  }
}
