import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { projectSnapshot, generateSuggestions } from './project-suggestions.mjs';
import { SettingsService } from './settings-service.mjs';
import { enginePreferences } from './settings-files.mjs';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AcpClient } from './acp-client.mjs';
import { canContinueRecovery, continuationParams, requestWithRecovery } from './response-recovery.mjs';
import { ChatPreferences } from './chat-preferences.mjs';
import { ModelPreferences } from './model-preferences.mjs';
import { ProjectStore } from './project-store.mjs';
import { ProjectChangesReader } from './project-changes.mjs';
import { GitService } from './git-service.mjs';
import { generateCommitMessage } from './commit-message.mjs';
import { geocodePlace } from './map-services.mjs';
import { readFile, stat, readdir, lstat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { fileAttachment, isPromptImage, prepareAttachmentFiles } from './attachment-files.mjs';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from './ipc.mjs';
import { ChatSearchIndex } from './chat-search.mjs';
import { chatTitle, isPlaceholderTitle } from './chat-title.mjs';
import { commandReport } from './command-reports.mjs';
import { SavedPrompts } from './saved-prompts.mjs';
import { DraftStore } from './draft-store.mjs';
import { QueueStore } from './queue-store.mjs';
import { BACKUP_EXTENSION, BackupService } from './backup.mjs';
import { FileAccess, TrustedFiles } from './file-access.mjs';
import { chatsToMarkdown, describeChat, exportFileName } from './chat-export.mjs';

const sizeLabel = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Reads picked files that fit in `room` more attachments. Accept every extension and
 * preserve binary bytes. A file that cannot be attached is reported with its reason
 * and never stops the others.
 */
export async function readAttachments(paths, room = MAX_ATTACHMENTS) {
  const files = [];
  const rejected = [];
  for (const filePath of paths) {
    const name = path.basename(filePath);
    let info;
    try { info = await stat(filePath); } catch { rejected.push({ name, reason: 'Could not be read' }); continue; }
    if (!info.isFile()) { rejected.push({ name, reason: info.isDirectory() ? 'Folders cannot be attached' : 'Not a regular file' }); continue; }
    if (info.size > MAX_ATTACHMENT_BYTES) { rejected.push({ name, reason: `${sizeLabel(info.size)} is over the 5 MB limit per file` }); continue; }
    if (files.length >= room) { rejected.push({ name, reason: `A message can carry ${MAX_ATTACHMENTS} files` }); continue; }
    try { files.push(fileAttachment(name, await readFile(filePath), pathToFileURL(filePath).href)); }
    catch (error) { rejected.push({ name, reason: error instanceof Error && /larger than/.test(error.message) ? 'Over the 5 MB limit per file' : 'Could not be read' }); }
  }
  return { files, rejected };
}

/** ACP prompt blocks for a message and its attachments. */
export function promptBlocks(text, attachments = []) {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  for (const item of attachments) {
    if (item.data !== undefined && isPromptImage(item.mimeType)) blocks.push({ type: 'image', data: item.data, mimeType: item.mimeType });
    else if (item.data !== undefined) throw new Error('Binary attachments must be prepared as local files');
    else blocks.push({ type: 'resource', resource: { uri: item.uri ?? `attachment:///${encodeURIComponent(item.name)}`, mimeType: item.mimeType, text: item.text } });
  }
  return blocks;
}

const genuiPrompt = JSON.parse(await readFile(new URL('./genui-prompt.json', import.meta.url), 'utf8'));
const standalonePrompt = JSON.parse(await readFile(new URL('./standalone-prompt.json', import.meta.url), 'utf8'));

const noVoice = { status: async () => ({ available: false }), start: async () => {}, stop: async () => {} };

// A keyless local provider (Ollama) counts as connected only while its server answers.
export async function localProviderRunning(baseUrl) {
  try {
    const response = await fetch(`${new URL(baseUrl).origin}/api/tags`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch { return false; }
}

export class DesktopBackend extends EventEmitter {
  constructor({ binary, settingsService = new SettingsService(), notify = () => {}, projects = new ProjectStore(), chatPreferences = new ChatPreferences(), clientFactory = (options) => new AcpClient(options), probe = localProviderRunning, voice = noVoice, attachmentDirectory = path.join(tmpdir(), 'handwork-attachments'), chatDirectory = path.join(settingsService.home || homedir(), '.handwork', 'desktop-chats'), savedPrompts = new SavedPrompts(), chatSearch = new ChatSearchIndex(path.join(settingsService.home || homedir(), '.handwork', 'sessions')), drafts = new DraftStore(), queues = new QueueStore(), trustedFiles = new TrustedFiles(), modelPreferences = new ModelPreferences(), shell = null }) {
    super();
    this.binary = binary;
    this.settingsService = settingsService;
    this.notify = notify;
    this.needsReconnect = false;
    this.attachmentDirectory = attachmentDirectory;
    this.chatDirectory = chatDirectory;
    this.projects = projects;
    this.chatPreferences = chatPreferences;
    this.clientFactory = clientFactory;
    this.probe = probe;
    this.voice = voice;
    this.workspace = null;
    this.suggestionCache = new Map();
    this.suggestionJob = null;
    this.suggestionEpoch = 0;
    this.recentSessions = [];
    this.sessionsCacheFile = chatPreferences.file ? chatPreferences.file + '.sessions' : null;
    this.engines = new Set();
    this.client = null;
    this.children = new Set();
    this.settingsClients = new Set();
    this.session = null;
    this.running = false;
    this.operationTail = Promise.resolve();
    this.historyReads = new Map();
    this.historyClient = null;
    this.disposed = false;
    this.changesReader = new ProjectChangesReader();
    this.git = new GitService({ emit: event => this.emit('event', event), openTerminal: directory => {
      if (!this.settingsService.host?.openTerminal) throw new Error('Opening a terminal is not available in this build.');
      return this.settingsService.host.openTerminal(directory);
    } });
    this.commitMessageClient = null;
    this.savedPrompts = savedPrompts;
    this.chatSearch = chatSearch;
    this.drafts = drafts;
    this.queues = queues;
    this.backups = new BackupService({ sessionDirectory: chatSearch.directory, chatDirectory, attachmentDirectory, home: settingsService.home, chatPreferences, savedPrompts, settings: settingsService.settings, modelPreferences, projects, drafts, queues, appVersion: settingsService.version });
    this.trustedFiles = trustedFiles;
    this.modelPreferences = modelPreferences;
    this.files = new FileAccess({ roots: () => [...this.projects.list(), this.attachmentDirectory, this.chatDirectory], trusted: trustedFiles, shell });
  }

  get prompting() { return [...this.engines].some(engine => engine.prompting || engine.running); }

  exclusive(action) {
    // Startup refreshes and navigation share workspace state. Preserve arrival
    // order without rejecting normal overlap; prompts still use per-chat locks.
    const operation = this.operationTail.then(async () => {
      if (this.disposed) throw new Error('Handwork is disconnected');
      this.running = true;
      try { return await action(); }
      finally { this.running = false; }
    });
    // A failed request must not prevent later operations from running.
    this.operationTail = operation.catch(() => {});
    return operation;
  }

  chooseWorkspace(picker) {
    return this.exclusive(async () => {
      const path = await picker();
      if (!path) return null;
      this.projects.add(path);
      this.selectWorkspace(path);
      return { path };
    });
  }

  listProjects() { return this.projects.list(); }
  removeProject(folder) { return this.projects.remove(folder); }

  projectChanges() { return this.changesReader.snapshot(this.workspace || ''); }
  geocodePlace(query) { return geocodePlace(query); }
  projectFileDiff(workspace, file, context = 3) {
    if (!workspace || workspace !== this.workspace) throw new Error('The selected project changed. Refresh its changes.');
    return this.changesReader.file(workspace, file, context);
  }

  // Picking files never touches the engine, so it must not wait behind a running prompt.
  /** Git reads and writes act on the selected project's repository only. */
  gitProject(workspace) {
    if (!workspace || workspace !== this.workspace) throw new Error('The selected project changed. Refresh its changes.');
    return workspace;
  }
  gitState(workspace) { return this.git.state(this.gitProject(workspace)); }
  gitFileDiff(workspace, file, area, context) { return this.git.fileDiff(this.gitProject(workspace), file, area, context); }
  gitStage(workspace, paths) { return this.git.stage(this.gitProject(workspace), paths); }
  gitUnstage(workspace, paths) { return this.git.unstage(this.gitProject(workspace), paths); }
  gitStageAll(workspace) { return this.git.stageAll(this.gitProject(workspace)); }
  gitUnstageAll(workspace) { return this.git.unstageAll(this.gitProject(workspace)); }
  gitCommit(workspace, message, expected) { return this.git.commit(this.gitProject(workspace), message, expected); }
  gitPush(workspace, expected) { return this.git.push(this.gitProject(workspace), expected); }
  gitPublish(workspace, remote) { return this.git.publish(this.gitProject(workspace), remote); }
  gitFetch(workspace) { return this.git.fetch(this.gitProject(workspace)); }
  gitPull(workspace) { return this.git.pull(this.gitProject(workspace)); }
  gitBranches(workspace) { return this.git.branches(this.gitProject(workspace)); }
  gitSwitchBranch(workspace, name) { return this.git.switchBranch(this.gitProject(workspace), name); }
  gitCreateBranch(workspace, name) { return this.git.createBranch(this.gitProject(workspace), name); }
  gitLog(workspace, limit) { return this.git.log(this.gitProject(workspace), limit); }
  gitCommitDetails(workspace, oid) { return this.git.commitDetails(this.gitProject(workspace), oid); }
  gitCommitFileDiff(workspace, oid, file, context) { return this.git.commitFileDiff(this.gitProject(workspace), oid, file, context); }
  gitOpenTerminal(workspace) { return this.git.openTerminal(this.gitProject(workspace)); }
  /** Drafts an editable message from the staged diff on the chat's model, outside the chat. */
  async gitCommitMessage(workspace) {
    this.gitProject(workspace);
    const config = this.session?.configOptions?.map(option => ({ ...option }));
    if (!config?.some(option => option.id === 'model' && option.currentValue)) throw new Error('Open a chat in this project to write a commit message.');
    const evidence = await this.git.commitContext(workspace);
    this.commitMessageClient?.dispose();
    const client = this.clientFactory({ binary: this.binary, cwd: workspace });
    this.commitMessageClient = client;
    this.children.add(client.exited);
    client.exited.then(() => this.children.delete(client.exited));
    try { return { ...(await generateCommitMessage(client, config, evidence.context)), head: evidence.head, index: evidence.index }; }
    finally { if (this.commitMessageClient === client) this.commitMessageClient = null; }
  }

  async chooseFiles(picker, room = MAX_ATTACHMENTS) {
    const paths = await picker();
    if (!paths?.length) return { files: [], rejected: [] };
    const result = await readAttachments(paths, room);
    // Files picked here stay openable from the message later.
    try { this.trustedFiles.add(paths); } catch { /* Opening later is optional. */ }
    return result;
  }

  /**
   * What shapes the open chat's replies: where it runs, which instruction files the
   * engine reads, and which extra folders it may use. Model settings and context
   * usage come from the session itself.
   */
  async chatDetails() {
    const workspace = this.workspace || '';
    const standalone = !workspace;
    const instructions = [];
    const add = async (file, scope) => {
      const info = await lstat(file).catch(() => null);
      if (info?.isFile()) instructions.push({ scope, path: file, bytes: info.size });
    };
    if (!standalone) {
      // The engine reads the global file, then AGENTS.md from the filesystem root down to the project.
      await add(path.join(this.settingsService.home, '.handwork', 'AGENTS.md'), 'app');
      const ancestors = [];
      for (let folder = path.dirname(workspace); folder !== path.dirname(folder); folder = path.dirname(folder)) ancestors.unshift(folder);
      for (const folder of ancestors) await add(path.join(folder, 'AGENTS.md'), 'ancestor');
      await add(path.join(workspace, 'AGENTS.md'), 'project');
    }
    // Only the saved preferences are needed; settingsInfo would also start the engine to ask its version.
    const preferences = standalone ? null : await enginePreferences(this.settingsService.home, workspace).catch(() => null);
    return {
      workspace, standalone, instructions, home: this.settingsService.home ?? '',
      directories: preferences?.directories ?? [],
      permissions: { global: preferences?.global ?? {}, project: preferences?.project ?? {} },
      sessionId: this.session?.sessionId ?? '',
    };
  }

  // Voice comes from a system dictation app the host detected; the renderer only sees availability.
  voiceStatus() { return this.voice.status(); }
  startVoice() { return this.voice.start(); }
  stopVoice() { return this.voice.stop(); }

  selectProject(path) {
    return this.exclusive(async () => {
      if (!this.projects.list().includes(path)) throw new Error('Choose this project with the folder picker first');
      if (!(await stat(path)).isDirectory()) throw new Error('Project folder is unavailable');
      this.selectWorkspace(path);
      return { path };
    });
  }

  selectChat() { return this.exclusive(async () => { this.selectWorkspace(''); return { path: '' }; }); }
  isStandaloneDirectory(directory) {
    if (typeof directory !== 'string' || !directory) return false;
    try { return realpathSync(directory).startsWith(realpathSync(this.chatDirectory) + path.sep); }
    catch { return directory.startsWith(this.chatDirectory + path.sep); }
  }
  displaySessions(result) {
    return { ...result, sessions: result.sessions.map(session => this.isStandaloneDirectory(session.cwd) ? { ...session, cwd: '', kind: 'chat' } : session) };
  }
  async standaloneAttachmentDirectories() {
    const entries = await readdir(this.chatDirectory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const directories = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const directory = path.join(this.chatDirectory, entry.name, 'attachments');
      const info = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!info) continue;
      if (!info.isDirectory()) throw new Error('An attachment folder contains unexpected items. Inspect it before clearing attachments.');
      directories.push(directory);
    }
    return directories;
  }

  selectWorkspace(workspace) {
    if (workspace !== this.workspace) {
      this.cancelSuggestions();
      this.client = null;
      this.session = null;
    }
    this.workspace = workspace;
  }

  activate(engine) {
    if (this.client !== engine.client) this.cancelSuggestions();
    this.workspace = engine.workspace;
    this.client = engine.client;
    this.session = engine.session;
    this.needsReconnect = engine.needsReconnect === true;
    return engine.commands ? { ...engine.session, availableCommands: engine.commands } : engine.session;
  }

  engineFor(sessionId = this.session?.sessionId) {
    const engine = typeof sessionId === 'string' && [...this.engines].find(item => item.session?.sessionId === sessionId && !item.client.closed);
    if (!engine) throw new Error('Connect to Handwork first');
    return engine;
  }

  async sessionExclusive(engine, action) {
    if (engine.running) throw new Error('Handwork is busy');
    engine.running = true;
    try { return await action(); }
    finally { engine.running = false; }
  }

  async openEngine(workspace = this.workspace) {
    if (this.disposed) throw new Error('Handwork is disconnected');
    if (workspace == null) throw new Error('Choose a workspace first');
    const standalone = workspace === '' || this.isStandaloneDirectory(workspace);
    const directory = workspace === '' ? path.join(this.chatDirectory, randomUUID()) : workspace;
    if (standalone) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const client = this.clientFactory({ binary: this.binary, cwd: directory });
    const engine = { client, workspace: standalone ? '' : workspace, directory, standalone, session: null, running: false, prompting: false, cancelling: false };
    this.engines.add(engine);
    this.children.add(client.exited);
    client.exited.then(() => { this.children.delete(client.exited); this.engines.delete(engine); });
    client.on('event', event => {
      if (event.method === 'handwork/session_read_update') return;
      if (!this.engines.has(engine)) return;
      const sessionId = engine.session?.sessionId ?? engine.loadingSessionId;
      if (event.method === 'session/update' && event.params?.update?.sessionUpdate === 'available_commands_update') engine.commands = event.params.update.availableCommands;
      const meta = event.params?.update?._meta?.handwork;
      if (event.method === 'session/update' && meta && Object.hasOwn(meta, 'modelResponseRecovery')) engine.recovery = meta.modelResponseRecovery;
      if (event.method === 'session/update' && event.params?.update?.sessionUpdate === 'usage_update' && sessionId) this.rememberUsage(sessionId, event.params.update);
      if (event.method === 'session/update' && event.params?.update?.sessionUpdate === 'session_info_update' &&
          sessionId && !engine.loadingSessionId && (!event.params.sessionId || event.params.sessionId === sessionId)) this.rememberTitle(sessionId, event.params.update.title);
      if (event.method === 'session/request_permission' &&
          (!engine.prompting || engine.cancelling || event.params.sessionId !== sessionId)) {
        client.respondPermission(event.id, null);
        return;
      }
      if (event.method === 'session/request_permission') this.notify('approval', event.params?.sessionId ?? sessionId);
      this.emit('event', { ...event, params: { ...event.params, sessionId: event.params?.sessionId ?? sessionId } });
      if (event.method === 'engine/error') {
        engine.session = null;
        if (this.client === client) this.session = null;
      }
    });
    try {
      const initialized = await client.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'handwork-desktop', version: '0.1.0' },
        clientCapabilities: { handwork: { responseInstructions: standalone ? standalonePrompt : genuiPrompt, ...(standalone ? { standaloneChat: true } : {}) } },
      });
      if (initialized?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
      if (standalone && !initialized.agentCapabilities?.handwork?.standaloneChat) throw new Error('Rebuild the Handwork engine to start standalone chats safely');
      return engine;
    } catch (error) {
      this.engines.delete(engine);
      client.dispose();
      throw error;
    }
  }

  connect() {
    return this.exclusive(async () => {
      if (this.client && !this.client.closed && this.session && !this.needsReconnect) return this.session;
      return this.createSession();
    });
  }

  ready() {
    if (!this.session) throw new Error('Connect to Handwork first');
    return this.readyClient();
  }

  // Session-independent operations only need a live engine (e.g. right after the active session was deleted).
  readyClient() {
    if (!this.client || this.client.closed) throw new Error('Connect to Handwork first');
    return this.client;
  }

  async createSession(standalone = false) {
    const engine = await this.openEngine(standalone ? '' : this.workspace);
    try {
      const result = await engine.client.request('session/new', { cwd: engine.directory, mcpServers: [] });
      if (typeof result?.sessionId !== 'string') throw new Error('Invalid session response');
      engine.session = { sessionId: result.sessionId, configOptions: result.configOptions ?? [] };
      const defaults = this.settingsService.snapshot(engine.workspace).effective;
      for (const [configId, value] of [['provider', defaults.defaultProvider], ['model', defaults.defaultModel], ['mode', defaults.defaultMode]]) {
        if (value && engine.session.configOptions.some(option => option.id === configId)) {
          const configured = await engine.client.request('session/set_config_option', { sessionId: result.sessionId, configId, value });
          if (Array.isArray(configured?.configOptions)) engine.session.configOptions = configured.configOptions;
        }
      }
      this.needsReconnect = false;
      return this.activate(engine);
    } catch (error) { this.engines.delete(engine); engine.client.dispose(); throw error; }
  }

  async prompt(text, attachments = [], sessionId) {
    const engine = this.engineFor(sessionId);
    return this.sessionExclusive(engine, async () => {
      if (engine.needsReconnect) throw new Error("Reconnect the project to apply its changed permissions before sending.");
      this.cancelSuggestions();
      const binaryFiles = attachments.some(item => item.data !== undefined && !isPromptImage(item.mimeType));
      const prepared = binaryFiles ? await prepareAttachmentFiles(attachments, engine.standalone ? path.join(engine.directory, 'attachments') : this.attachmentDirectory) : attachments;
      const blocks = promptBlocks(text, prepared);
      if (!blocks.length) throw new Error('Nothing to send');
      this.recordModelUse(engine);
      return this.runPrompt(engine, { sessionId: engine.session.sessionId, prompt: blocks });
    });
  }

  /**
   * The engine reports context usage only while a chat is live, and not when its
   * history is replayed, so the latest figure is saved with the chat's preferences.
   */
  rememberUsage(sessionId, update) {
    if (!Number.isFinite(update.used) || update.used < 0) return;
    const usage = { used: update.used, ...(Number.isFinite(update.size) && update.size > 0 ? { size: update.size } : {}), at: Date.now() };
    const previous = this.chatPreferences.list()[sessionId]?.usage;
    if (previous?.used === usage.used && previous?.size === usage.size) return;
    try {
      this.chatPreferences.update(sessionId, { usage });
      this.emit('event', { method: 'desktop/chat-usage', params: { sessionId, usage } });
    } catch { /* Context usage is optional; the live figure still shows. */ }
  }

  /** Keep live generated titles when the engine's saved history still has a prompt preview. */
  rememberTitle(sessionId, title) {
    if (isPlaceholderTitle(title)) return;
    try {
      if (this.chatPreferences.list()[sessionId]?.generatedTitle !== title) this.chatPreferences.update(sessionId, { generatedTitle: title });
    } catch { /* A failed optional metadata write must not interrupt the response. */ }
  }

  /** Counts the chat's provider and model as used. Model shortcuts are optional. */
  recordModelUse(engine) {
    const options = engine.session?.configOptions ?? [];
    const provider = options.find(option => option.id === 'provider')?.currentValue ?? '';
    const model = options.find(option => option.id === 'model');
    if (typeof provider !== 'string' || typeof model?.currentValue !== 'string' || !model.currentValue) return;
    const find = items => Array.isArray(items) ? items.reduce((found, item) => found ?? (item?.value === model.currentValue ? item : find(item?.options)), undefined) : undefined;
    const name = find(model.options)?.name;
    try {
      const preferences = this.modelPreferences.recordUse(provider, model.currentValue, typeof name === 'string' ? name : model.currentValue);
      this.emit('event', { method: 'desktop/models', params: preferences });
    } catch { /* Sending never depends on model shortcuts. */ }
  }
  getModelPreferences() { return this.modelPreferences.list(); }
  setModelFavorite(provider, model, name, favorite) {
    const preferences = this.modelPreferences.setFavorite(provider, model, name, favorite);
    this.emit('event', { method: 'desktop/models', params: preferences });
    return preferences;
  }

  async continueResponse(sessionId) {
    const engine = this.engineFor(sessionId);
    return this.sessionExclusive(engine, async () => {
      if (engine.needsReconnect) throw new Error('Reconnect the project before retrying.');
      if (!canContinueRecovery(engine.recovery)) throw new Error('No paused response is ready to retry.');
      this.cancelSuggestions();
      return this.runPrompt(engine, continuationParams(engine.session.sessionId));
    });
  }

  async runPrompt(engine, params) {
    const { client } = engine;
    const publishRecovery = recovery => this.emit('event', { method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'session_info_update', _meta: { handwork: { modelResponseRecovery: recovery } } } } });
    publishRecovery(null);
    engine.prompting = true;
    engine.cancelling = false;
    try {
      const result = await requestWithRecovery(engine, params, {
        onWaiting: publishRecovery,
      });
      publishRecovery(engine.recovery?.state === 'paused' ? engine.recovery : null);
      if (result?.stopReason === 'end_turn' && engine.recovery?.state !== 'paused') {
        this.notify('complete', engine.session?.sessionId);
      }
      return { ...result, recoveryPaused: engine.recovery?.state === 'paused' };
    } catch (error) {
      publishRecovery(engine.recovery?.state === 'paused' ? engine.recovery : null);
      this.notify('error', params.sessionId);
      throw error;
    } finally {
      engine.prompting = false;
      engine.cancelling = false;
      if (!client.closed) client.cancelPermissions();
    }
  }

  async cancel(sessionId) {
    const engine = this.engineFor(sessionId);
    if (!engine.prompting) return;
    engine.cancelling = true;
    engine.client.cancelPermissions();
    engine.client.send({ method: 'session/cancel', params: { sessionId: engine.session.sessionId } });
  }

  newSession() {
    return this.exclusive(() => this.createSession());
  }
  newChat() { return this.exclusive(() => this.createSession(true)); }

  listCachedSessions() {
    if (!this.recentSessions.length && this.sessionsCacheFile) {
      try {
        const sessions = JSON.parse(readFileSync(this.sessionsCacheFile, 'utf8'));
        if (Array.isArray(sessions) && sessions.every(item => typeof item?.sessionId === 'string')) this.recentSessions = sessions;
      } catch { /* A missing or damaged cache must not block startup. */ }
    }
    const preferences = this.chatPreferences.list();
    return this.displaySessions({ sessions: this.recentSessions.map(session => {
      const preference = Object.hasOwn(preferences, session.sessionId) ? preferences[session.sessionId] : {};
      return { ...session, title: preference.title || preference.generatedTitle || session.title, pinned: preference.pinned === true, archived: preference.archived === true };
    }), preferences });
  }

  saveSessionCache() {
    if (!this.sessionsCacheFile) return;
    const temporary = this.sessionsCacheFile + '.tmp';
    try {
      mkdirSync(path.dirname(this.sessionsCacheFile), { recursive: true });
      writeFileSync(temporary, JSON.stringify(this.recentSessions), { mode: 0o600 });
      renameSync(temporary, this.sessionsCacheFile);
    } catch { /* History refresh succeeds even if the optional cache cannot be written. */ }
  }

  listSessions() { return this.exclusive(() => this.collectSessions()); }
  async collectSessions() {
      const foreground = [...this.engines].find(item => item.client === this.client);
      const temporary = !this.client || this.client.closed || foreground?.running ? await this.openEngine() : null;
      const client = temporary?.client ?? this.readyClient();
      try {
      const sessions = new Map();
      const cursors = new Set();
      let cursor;
      do {
        // Omitting cwd asks the engine for saved chats across all workspaces.
        const page = await client.request('session/list', cursor ? { cursor } : {});
        if (!Array.isArray(page?.sessions)) throw new Error('Invalid saved chat list');
        for (const session of page.sessions) sessions.set(session.sessionId, session);
        cursor = page.nextCursor;
        if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) throw new Error('Invalid saved chat continuation');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      const preferences = this.chatPreferences.list();
      const result = { sessions: [...sessions.values()].map(session => {
        const preference = Object.hasOwn(preferences, session.sessionId) ? preferences[session.sessionId] : {};
        return { ...session, title: preference.title || preference.generatedTitle || session.title, pinned: preference.pinned === true, archived: preference.archived === true };
      }), preferences };
      // Untitled history gets a prompt preview without loading or switching an engine.
      const untitled = result.sessions.filter(session => !preferences[session.sessionId]?.title && isPlaceholderTitle(session.title));
      for (let index = 0; index < untitled.length; index += 16) {
        await Promise.all(untitled.slice(index, index + 16).map(async session => {
          try { await this.chatSearch.readSession(session.sessionId); } catch { /* Unreadable history stays a new chat. */ }
          const prompt = this.chatSearch.sessions.get(session.sessionId)?.messages.find(message => message.role === 'user')?.text;
          session.title = chatTitle(session.title, prompt);
        }));
      }
      this.recentSessions = result.sessions;
      this.saveSessionCache();
      return this.displaySessions(result);
      } finally { if (temporary) { this.engines.delete(temporary); temporary.client.dispose(); } }
  }

  getSettings() { return this.settingsService.snapshot(this.workspace); }
  updateSettings(scope, patch) {
    const result = this.settingsService.settings.update(scope, patch, this.workspace);
    if (!result.effective.suggestions) { this.cancelSuggestions(); this.suggestionCache.clear(); }
    this.emit('event', { method: 'desktop/settings', params: result });
    return result;
  }
  resetProjectSettings() { const result = this.settingsService.settings.resetProject(this.workspace); this.emit('event', { method: 'desktop/settings', params: result }); return result; }
  getStartup() { return this.settingsService.settings.startup(); }
  saveStartup(value) { const known = this.projects.list(); if (value.tabs.some(tab => tab.workspace !== '' && !known.includes(tab.workspace))) throw new Error('Unknown startup project'); this.settingsService.settings.saveStartup(value); }
  async settingsInfo() { return this.settingsService.info(this.binary, this.workspace, this.attachmentDirectory, await this.standaloneAttachmentDirectories()); }
  getInstructions(scope) { return this.settingsService.instructions(this.workspace, scope); }
  saveInstructions(scope, text, revision) { return this.settingsService.saveInstructions(this.workspace, scope, text, revision); }
  openSettingsTarget(target) { return this.settingsService.openTarget(this.workspace, target, this.attachmentDirectory); }
  async clearSuggestionCache() { const result = await this.settingsService.clearSuggestions(this); this.emit('event', { method: 'desktop/suggestions-cleared' }); return result; }
  async clearAttachments() {
    if (this.prompting) throw new Error('Wait for the current response to finish');
    const directories = [this.attachmentDirectory, ...await this.standaloneAttachmentDirectories()];
    let removed = 0;
    for (const directory of directories) removed += (await this.settingsService.clearAttachments(directory)).removed;
    return { removed };
  }
  commandReport(command) { return commandReport(this.binary, command, this.workspace || this.settingsService.home); }
  async diagnostics() { return this.settingsService.diagnostics(this.binary, this.workspace, this.attachmentDirectory, await this.standaloneAttachmentDirectories()); }
  testNotification() { return this.notify('test'); }
  checkUpdates() { if (!this.settingsService.host.checkUpdates) throw new Error('Desktop update checking is not configured in this build'); return this.settingsService.host.checkUpdates(); }
  getUpdateState() { return this.settingsService.host.getUpdateState(); }
  downloadUpdate() { return this.settingsService.host.downloadUpdate(); }
  installUpdate(drafts) { return this.settingsService.host.installUpdate(drafts); }
  getUpdateDrafts() { return this.settingsService.host.getUpdateDrafts(); }
  setToolPermission(scope, category, action) {
    return this.exclusive(async () => {
      await this.readyClient().request('handwork/settings/permission', { scope, category, action });
      this.markReconnect(scope);
      return this.settingsInfo();
    });
  }
  markReconnect(scope) {
    for (const engine of this.engines) {
      if (scope !== 'project' || engine.workspace === this.workspace) engine.needsReconnect = true;
    }
    this.needsReconnect = true;
    this.cancelSuggestions();
  }

  async addProjectFolder() {
    const selected = await this.settingsService.host.chooseFolder?.();
    if (!selected) return null;
    return this.exclusive(async () => { await this.readyClient().request('handwork/settings/directory', { action: 'add', path: selected }); this.markReconnect('project'); return this.settingsInfo(); });
  }
  removeProjectFolder(folder) {
    return this.exclusive(async () => {
      const current = await this.settingsInfo();
      if (!current.enginePreferences.directories.includes(folder)) throw new Error('This folder is not configured for the project');
      await this.readyClient().request('handwork/settings/directory', { action: 'remove', path: folder }); this.markReconnect('project');
      return this.settingsInfo();
    });
  }
  async providerModels(provider, testConnection = false) {
    const available = await this.listProviders();
    if (!(available.providers ?? []).some(item => item.id === provider && item.connected)) throw new Error('Connect this provider first');
    if (this.settingsClients.size >= 3) throw new Error('A provider check is already running. Try again shortly.');
    const client = this.clientFactory({ binary: this.binary, cwd: this.workspace || this.settingsService.home });
    this.settingsClients.add(client);
    this.children.add(client.exited); client.exited.then(() => this.children.delete(client.exited));
    try {
      const initialized = await client.request('initialize', { protocolVersion: 1, clientCapabilities: { handwork: { backgroundTask: true } } });
      if (!initialized.agentCapabilities?.handwork?.backgroundTask) throw new Error('Rebuild the Handwork engine to inspect provider models without creating saved chats');
      const session = await client.request('session/new', { mcpServers: [] });
      const result = await client.request('session/set_config_option', { sessionId: session.sessionId, configId: 'provider', value: provider });
      if (testConnection) {
        const reply = await client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Reply with OK. This is a connection test.' }] }, { timeout: 30000 });
        if (reply.stopReason !== 'end_turn') throw new Error('The connection test did not finish');
      }
      return { configOptions: result.configOptions ?? session.configOptions ?? [] };
    } finally { this.settingsClients.delete(client); client.dispose(); }
  }
  async testProvider(provider) {
    const result = await this.providerModels(provider, true);
    const model = result.configOptions.find(option => option.id === 'model');
    const count = model?.options?.length ?? 0;
    if (!count) throw new Error('The provider returned no available models');
    return { message: `Connection verified. ${count} models available.`, models: count };
  }
  /** Exports the open chat or every chat, as JSON for tools or Markdown for people. */
  exportChats(scope, format = 'json') {
    return this.exclusive(async () => {
      this.readyClient();
      await this.collectSessions();
      const current = this.session?.sessionId;
      const saved = this.recentSessions.find(item => item.sessionId === current);
      const title = (current && this.chatPreferences.list()[current]?.title) || saved?.title || 'Chat';
      const destination = await this.settingsService.host.saveExport?.({ format, defaultName: exportFileName(scope, format, title) });
      if (!destination) return { cancelled: true };
      // Standalone chats run in a private folder; the engine directory works for both kinds.
      const sessions = scope === 'current' ? [{ sessionId: current, cwd: this.engineFor().directory, title }] : this.recentSessions.filter(item => item.turns !== 0);
      const chats = []; let bytes = 0;
      for (const session of sessions) {
        // The read-only history path works even while the chat is open in its own engine.
        const { updates } = await this.readSession(session.sessionId);
        const messages = [];
        for (const update of updates) {
          if (!['user_message_chunk', 'agent_message_chunk'].includes(update?.sessionUpdate) || update.content?.type !== 'text') continue;
          bytes += Buffer.byteLength(update.content.text);
          if (bytes > 100 * 1024 * 1024) throw new Error('Export exceeds 100 MB. Export individual chats instead.');
          const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
          const last = messages.at(-1);
          // Progress notes and the final answer of one turn read as consecutive paragraphs.
          if (last?.role === role && last.id === update.messageId) last.text += update.content.text;
          else if (last?.role === 'assistant' && role === 'assistant') { last.text = `${last.text.trimEnd()}\n\n${update.content.text}`; last.id = update.messageId; }
          else messages.push({ role, id: update.messageId, text: update.content.text });
        }
        chats.push({ id: session.sessionId, title: (this.chatPreferences.list()[session.sessionId]?.title) || session.title, workspace: session.cwd, messages });
      }
      const { writeFile, rename, unlink } = await import('node:fs/promises');
      const temporary = destination + '.handwork-' + randomUUID() + '.tmp';
      const body = format === 'markdown'
        ? chatsToMarkdown(chats.map(chat => describeChat(chat, directory => this.isStandaloneDirectory(directory))))
        : JSON.stringify({ version: 1, chats }, null, 2);
      try { await writeFile(temporary, body, { mode: 0o600, flag: 'wx' }); await rename(temporary, destination); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      return { path: destination, count: chats.length };
    });
  }

  saveDraft(key, text, files) { return this.drafts.save(key, text, files); }
  listDrafts() { return this.drafts.list(); }
  moveDraft(source, target) { return this.drafts.move(source, target); }
  removeDrafts(keys) { this.drafts.remove(keys); return { removed: keys.length }; }
  listQueues() { return this.queues.list(); }
  saveQueue(sessionId, queue) { return this.queues.save(sessionId, queue); }

  /** Writes a full, restorable backup to a file the person chooses. */
  createBackup() {
    return this.exclusive(async () => {
      const date = new Date().toISOString().slice(0, 10);
      const destination = await this.settingsService.host.saveBackup?.({ defaultName: `Handwork backup ${date}.${BACKUP_EXTENSION}` });
      if (!destination) return { cancelled: true };
      return this.backups.create(destination);
    });
  }
  /** Checks a backup the person chooses and reports what restoring it would add. */
  async previewBackup() {
    if (!this.settingsService.host.chooseBackup) throw new Error('Restoring backups is unavailable in this preview');
    const file = await this.settingsService.host.chooseBackup();
    if (!file) return { cancelled: true };
    return this.backups.preview(file);
  }
  restoreBackup(token, categories) {
    return this.exclusive(async () => {
      if (this.prompting) throw new Error('Wait for running replies to finish before restoring.');
      const result = await this.backups.restore(token, categories);
      if (result.preferences) this.emit('event', { method: 'desktop/settings', params: this.getSettings() });
      if (result.preferences) { try { this.emit('event', { method: 'desktop/models', params: this.modelPreferences.list() }); } catch { /* Model shortcuts are optional. */ } }
      // Restored chats join the saved list; the next refresh reads them from the engine.
      if (result.chats) { this.recentSessions = []; if (this.client && !this.client.closed) await this.collectSessions().catch(() => {}); }
      return result;
    });
  }
  previewFile(target) { return this.files.preview(target, this.workspace); }
  openFile(target) { return this.files.open(target, this.workspace); }
  revealFile(target) { return this.files.reveal(target, this.workspace); }
  // Search reads saved history directly, so it never waits behind a running prompt.
  searchChats(query) { return this.chatSearch.search(query); }
  listPrompts() { return this.savedPrompts.list(); }
  savePrompt(prompt) { return this.savedPrompts.save(prompt); }
  deletePrompt(id) { return this.savedPrompts.remove(id); }
  async captureScreen() {
    if (!this.settingsService.host.captureScreen) throw new Error('Screen capture is unavailable in this preview');
    return this.settingsService.host.captureScreen();
  }

  updateChat(sessionId, changes) {
    if (sessionId !== this.session?.sessionId && ![...this.engines].some(engine => engine.session?.sessionId === sessionId) && !this.recentSessions.some(session => session.sessionId === sessionId)) throw new Error('Chat is no longer available');
    return this.chatPreferences.update(sessionId, changes);
  }

  async projectSuggestions() {
    if (!this.workspace) return [];
    this.ready();
    if (!this.settingsService.snapshot(this.workspace).effective.suggestions) return [];
    const workspace = this.workspace;
    const config = this.session.configOptions;
    const route = JSON.stringify(config.filter(option => ['provider', 'model', 'effort', 'fast_mode'].includes(option.id)).map(option => [option.id, option.currentValue]));
    const key = workspace + route;
    const epoch = this.suggestionEpoch;
    const snapshot = await projectSnapshot(workspace, this.recentSessions);
    const currentRoute = JSON.stringify((this.session?.configOptions ?? []).filter(option => ['provider', 'model', 'effort', 'fast_mode'].includes(option.id)).map(option => [option.id, option.currentValue]));
    if (workspace !== this.workspace || route !== currentRoute || this.prompting) return [];
    const cached = this.suggestionCache.get(key);
    if (cached?.fingerprint === snapshot.fingerprint && Date.now() - cached.at < 300000) return cached.items;
    if (this.suggestionJob?.key === key && this.suggestionJob.fingerprint === snapshot.fingerprint) return this.suggestionJob.promise;
    if (epoch !== this.suggestionEpoch) return [];
    this.cancelSuggestions();
    const client = this.clientFactory({ binary: this.binary, cwd: workspace });
    this.children.add(client.exited);
    client.exited.then(() => this.children.delete(client.exited));
    const job = { key, fingerprint: snapshot.fingerprint, client, promise: null };
    this.suggestionJob = job;
    job.promise = generateSuggestions(client, config, snapshot.context).then(items => {
      if (this.suggestionJob === job) {
        this.suggestionCache.set(key, { items, fingerprint: snapshot.fingerprint, at: Date.now() });
        if (this.suggestionCache.size > 20) this.suggestionCache.delete(this.suggestionCache.keys().next().value);
      }
      return items;
    }).finally(() => { if (this.suggestionJob === job) this.suggestionJob = null; });
    return job.promise;
  }

  cancelSuggestions() {
    this.suggestionEpoch++;
    this.suggestionJob?.client.dispose();
    this.suggestionJob = null;
  }

  deleteSession(sessionId) {
    return this.exclusive(async () => {
      const engine = [...this.engines].find(item => item.session?.sessionId === sessionId);
      if (engine?.running) throw new Error('Handwork is busy');
      const temporary = !engine ? await this.openEngine() : null;
      let result;
      try { result = await (engine ?? temporary).client.request('session/remove', { sessionId }); }
      finally { if (temporary) { this.engines.delete(temporary); temporary.client.dispose(); } }
      try { this.queues.remove([sessionId]); } catch { /* A leftover queue is ignored for a missing chat. */ }
      try { this.chatPreferences.remove(sessionId); }
      catch { this.emit('event', { method: 'desktop/notice', params: { message: 'The chat was deleted, but its local display preferences could not be removed.' } }); }
      // The engine releases a deleted active session; the renderer starts or loads another.
      if (engine) engine.session = null;
      if (this.session?.sessionId === sessionId) this.session = null;
      this.recentSessions = this.recentSessions.filter(session => session.sessionId !== sessionId);
      this.saveSessionCache();
      return result;
    });
  }

  async rewindSession(turnIndex, expectedText, sessionId) {
    const engine = this.engineFor(sessionId);
    return this.sessionExclusive(engine, async () => {
      const original = engine.session.sessionId;
      const result = await engine.client.request('session/rewind', { sessionId: original, turnIndex, expectedText });
      if (typeof result?.sessionId !== 'string') throw new Error('Invalid rewind response');
      engine.session = { sessionId: result.sessionId, configOptions: result.configOptions ?? [] };
      if (this.client === engine.client) this.session = engine.session;
      // The original stays saved; link the new chat to it so either version can be reopened.
      const branch = { from: original, turn: turnIndex, at: Date.now() };
      try {
        // A chat the person renamed keeps its name in every version.
        const title = this.chatPreferences.list()[original]?.title;
        this.chatPreferences.update(result.sessionId, { branch, ...(title ? { title } : {}) });
      }
      catch { return result; /* The new chat still works without a version link. */ }
      return { ...result, branch };
    });
  }

  readSession(sessionId) {
    if (this.historyReads.has(sessionId)) return this.historyReads.get(sessionId);
    const reading = (async () => {
      if (this.disposed) throw new Error('Handwork is disconnected');
      // The read-only extension works before initialize, so opening a chat
      // never waits for credentials, model discovery, or project MCP startup.
      if (!this.historyClient || this.historyClient.closed) {
        const client = this.clientFactory({ binary: this.binary, cwd: this.settingsService.home });
        this.historyClient = client;
        this.children.add(client.exited);
        client.exited.then(() => this.children.delete(client.exited));
      }
      const client = this.historyClient;
      const updates = [];
      const collect = event => {
        if (event.method === 'handwork/session_read_update' && event.params?.sessionId === sessionId) updates.push(event.params.update);
      };
      client.on('event', collect);
      try {
        const result = await client.request('handwork/session/read', { sessionId });
        const preference = this.chatPreferences.list()[sessionId];
        const title = preference?.title || preference?.generatedTitle;
        if (title) updates.push({ sessionUpdate: 'session_info_update', title });
        return { ...result, ...(title ? { title } : {}), updates };
      } finally { client.off('event', collect); }
    })().finally(() => this.historyReads.delete(sessionId));
    this.historyReads.set(sessionId, reading);
    return reading;
  }

  loadSession(sessionId) {
    return this.exclusive(async () => {
      const retained = [...this.engines].find(engine => engine.session?.sessionId === sessionId && !engine.client.closed);
      if (retained) return { ...this.activate(retained), historyReplayed: false };
      this.listCachedSessions();
      const saved = this.recentSessions.find(session => session.sessionId === sessionId);
      const workspace = saved?.cwd ?? (await this.readSession(sessionId)).cwd ?? this.workspace;
      const engine = await this.openEngine(workspace);
      engine.loadingSessionId = sessionId;
      try {
        const result = await engine.client.request('session/load', { sessionId, cwd: workspace, mcpServers: [] });
        engine.session = { sessionId, configOptions: result.configOptions ?? [] };
        const savedConfig = this.chatPreferences.list()[sessionId]?.config ?? {};
        // Restore the provider first because it determines the available models.
        for (const configId of ['provider', 'model', 'effort', 'fast_mode']) {
          const value = savedConfig[configId];
          const option = engine.session.configOptions.find(option => option.id === configId);
          if (typeof value !== 'string' || !option || option.currentValue === value) continue;
          const configured = await engine.client.request('session/set_config_option', { sessionId, configId, value });
          if (Array.isArray(configured?.configOptions)) engine.session.configOptions = configured.configOptions;
        }
        const preference = this.chatPreferences.list()[sessionId];
        const title = preference?.title || preference?.generatedTitle;
        if (title) this.emit('event', { method: 'session/update', params: { sessionId, update: { sessionUpdate: 'session_info_update', title } } });
        return { ...result, ...this.activate(engine), historyReplayed: true };
      } catch (error) { this.engines.delete(engine); engine.client.dispose(); throw error; }
      finally { delete engine.loadingSessionId; }
    });
  }

  async setConfig(configId, value, sessionId) {
    const engine = this.engineFor(sessionId);
    this.cancelSuggestions();
    return this.sessionExclusive(engine, async () => {
      const result = await engine.client.request('session/set_config_option', { sessionId: engine.session.sessionId, configId, value });
      if (Array.isArray(result?.configOptions)) engine.session.configOptions = result.configOptions;
      if (['provider', 'model', 'effort', 'fast_mode'].includes(configId)) {
        const config = Object.fromEntries(engine.session.configOptions
          .filter(option => ['provider', 'model', 'effort', 'fast_mode'].includes(option.id))
          .map(option => [option.id, option.currentValue]));
        this.chatPreferences.update(engine.session.sessionId, { config });
      }
      return result;
    });
  }

  async respondPermission(requestId, optionId, sessionId) {
    this.engineFor(sessionId).client.respondPermission(requestId, optionId);
  }

  async withLocalProbe(result) {
    const providers = Array.isArray(result?.providers) ? result.providers : null;
    if (!providers) return result;
    await Promise.all(providers.map(async (provider) => {
      if (provider?.signIn === 'none' && typeof provider.baseUrl === 'string') provider.connected = await this.probe(provider.baseUrl);
    }));
    return result;
  }

  async listProviders() {
    const result = await this.exclusive(() => this.providerRequest('handwork/providers/list', {}));
    return this.withLocalProbe(result);
  }

  providerUsage(provider) {
    if (provider !== 'codex') return Promise.reject(new Error('Subscription usage is only available for Codex'));
    if (this.usageJob) return this.usageJob;
    if (this.settingsClients.size >= 3) return Promise.reject(new Error('A provider check is already running. Try again shortly.'));
    // Never queue a network usage check on the active chat's ACP connection.
    this.usageJob = this.providerRequest('handwork/providers/usage', { provider }, true)
      .catch(cause => {
        if (/method not found|unknown method/i.test(cause?.message ?? '')) throw new Error('Update the Handwork engine to view subscription usage.');
        throw cause;
      })
      .finally(() => { this.usageJob = null; });
    return this.usageJob;
  }

  async providerRequest(method, params, background = false) {
    if (!background && this.client && !this.client.closed) return this.client.request(method, params);
    // Provider setup must work before a chat has credentials. This short-lived
    // process only manages credentials; it never creates sessions or runs prompts.
    const client = this.clientFactory({
      binary: this.binary,
      cwd: this.settingsService.home,
      env: { ...process.env, HANDWORK_AUTH_MODE: 'host-managed' },
    });
    this.settingsClients.add(client);
    this.children.add(client.exited);
    client.exited.then(() => this.children.delete(client.exited));
    try {
      const initialized = await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { handwork: { backgroundTask: true } },
      });
      if (!initialized.agentCapabilities?.handwork?.backgroundTask) throw new Error('Rebuild the Handwork engine to manage providers before starting a chat');
      return await client.request(method, params);
    } finally {
      this.settingsClients.delete(client);
      client.dispose();
    }
  }

  async connectProvider(provider, apiKey) {
    const result = await this.exclusive(() => this.providerRequest('handwork/providers/connect', { provider, apiKey }));
    return this.withLocalProbe(result);
  }

  async disconnectProvider(provider) {
    const result = await this.exclusive(() => this.providerRequest('handwork/providers/disconnect', { provider }));
    return this.withLocalProbe(result);
  }

  // Browser sign-ins run the CLI in its own process so the OAuth flow's output never touches the ACP pipe.
  signInProvider(provider) {
    if (!/^[a-z_]+$/.test(provider)) return Promise.reject(new Error('Unknown provider'));
    return this.exclusive(() => new Promise((resolve, reject) => {
      const child = spawn(this.binary, ['login', provider], { cwd: this.workspace ?? undefined, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
      let output = '';
      const collect = (chunk) => { output = (output + chunk.toString('utf8')).slice(-8192); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Sign-in timed out')); }, 5 * 60 * 1000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ ok: true });
        else reject(new Error(output.trim().split('\n').pop() || `Sign-in failed (${code})`));
      });
    }));
  }

  dispose() {
    this.disposed = true;
    this.historyClient?.dispose();
    this.cancelSuggestions();
    this.commitMessageClient?.dispose();
    for (const client of this.settingsClients) client.dispose();
    this.settingsClients.clear();
    for (const engine of this.engines) engine.client.dispose();
    this.engines.clear();
    this.client = null;
    this.session = null;
    return Promise.allSettled([...this.children]);
  }
}
