import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { AcpClient } from './acp-client.mjs';
import { claudeUsageAccount, claudeUsageGeneration, recordClaudeUsage } from './claude-usage.mjs';
import { searchDirectories } from './provider-updates.mjs';

const option = (id, name, currentValue, values) => ({ id, name, type: 'select', currentValue, options: values.map(([value, name]) => ({ value, name })) });

export async function claudeBinary() {
  if (process.env.HANDWORK_CLAUDE_PATH) return process.env.HANDWORK_CLAUDE_PATH;
  for (const directory of searchDirectories()) {
    const binary = path.join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude');
    try { accessSync(binary, constants.X_OK); return binary; } catch { /* Try the next installation. */ }
  }
  throw new Error('Install Claude Code, run claude auth login, then reopen Handwork.');
}
export async function claudeStatus() {
  try {
    const binary = await claudeBinary();
    const result = await new Promise((resolve, reject) => execFile(binary, ['auth', 'status', '--json'], { timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const status = JSON.parse(result);
    claudeUsageAccount(status);
    return status.loggedIn === true;
  } catch { claudeUsageAccount(null); return false; }
}

export function concreteClaudeModels(rows) {
  const concrete = rows.filter(row => row.value !== 'default');
  const preferred = rows.find(row => row.value === 'default');
  if (preferred?.resolvedModel) {
    const matching = concrete.find(row => row.value === preferred.resolvedModel || row.resolvedModel === preferred.resolvedModel);
    if (matching) return [matching, ...concrete.filter(row => row !== matching)];
    return [{ ...preferred, value: preferred.resolvedModel, displayName: preferred.resolvedModel }, ...concrete];
  }
  if (!concrete.length) throw new Error('Claude Code did not report a concrete model.');
  return concrete;
}

/** Initialization only: no user prompt, model inference, or credential extraction. */
export async function discoverClaudeModels({ cwd, locate = claudeBinary, query, timeout = 15000 } = {}) {
  const binary = await locate();
  const run = query || (await import('@anthropic-ai/claude-agent-sdk')).query;
  const controller = new AbortController();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  async function* input() { await waiting; }
  let connection;
  let timer;
  try {
    connection = run({ prompt: input(), options: {
      cwd, pathToClaudeCodeExecutable: binary, executable: 'node',
      abortController: controller, persistSession: false,
      settingSources: ['user', 'project', 'local'],
      env: { ...process.env, PATH: searchDirectories().join(path.delimiter) },
    } });
    const rows = await Promise.race([
      connection.supportedModels(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Claude Code model discovery timed out.')); }, timeout); }),
    ]);
    const seen = new Set();
    const models = rows.filter(row => typeof row?.value === 'string' && row.value && typeof row.displayName === 'string' && row.displayName && !seen.has(row.value) && seen.add(row.value));
    if (!models.length) throw new Error('Claude Code returned no models. Check its installation and authentication.');
    return concreteClaudeModels(models);
  } finally { clearTimeout(timer); release(); connection?.close(); }
}

/** Routes Claude Code through its official SDK while retaining the native ACP engine. */
export class ClaudeClient extends EventEmitter {
  constructor(options, { native = new AcpClient(options), query, discover = discoverClaudeModels, status = claudeStatus, locate = claudeBinary, directory = path.join(homedir(), '.handwork', 'sessions') } = {}) {
    super();
    this.discover = discover; this.native = native; this.options = options; this.query = query; this.status = status; this.locate = locate; this.directory = directory;
    this.freshSessions = new Set(); this.permissions = new Map(); this.session = null; this.closed = false;
    this.exited = native.exited;
    native.on('event', event => this.emit('event', event));
  }
  file(id) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid session ID');
    return path.join(this.directory, id, 'claude.json');
  }
  read(id) {
    try { return JSON.parse(readFileSync(this.file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  save() {
    if (this.background || !this.session) return;
    mkdirSync(path.dirname(this.file(this.session.sessionId)), { recursive: true, mode: 0o700 });
    const file = this.file(this.session.sessionId), temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.session), { mode: 0o600 }); renameSync(temporary, file);
  }
  async refreshModels() {
    const discovered = await this.discover({ cwd: this.session?.cwd || this.options.cwd, locate: this.locate });
    this.catalogue = concreteClaudeModels(discovered);
    if (this.session) {
      const previous = this.session.models?.find(row => row.value === this.session.model);
      if (this.session.model === 'default') this.session.model = this.catalogue.find(row => previous?.resolvedModel && (row.resolvedModel === previous.resolvedModel || row.value === previous.resolvedModel))?.value || this.catalogue[0].value;
      this.session.models = this.catalogue;
      const model = this.catalogue.find(row => row.value === this.session.model || row.resolvedModel === this.session.model);
      if (model) this.session.model = model.value;
      if (!model?.supportedEffortLevels?.includes(this.session.effort)) delete this.session.effort;
      if (!model?.supportsFastMode) delete this.session.fast;
      this.save();
    }
    return this.catalogue;
  }
  config(session = this.session) {
    const stored = session.models || this.catalogue || [];
    const models = stored.length ? concreteClaudeModels(stored) : [];
    const currentModel = session.model === 'default' ? models[0]?.value : session.model;
    const choices = models.map(row => ({ value: row.value, name: row.displayName, description: [row.description, row.resolvedModel && row.resolvedModel !== row.value ? row.resolvedModel : ''].filter(Boolean).join(' · ') }));
    if (!choices.some(row => row.value === currentModel)) choices.unshift({ value: currentModel, name: currentModel, description: 'Saved model; availability has not been confirmed.' });
    const config = [option('provider', 'Provider', 'claude', [['claude', 'Claude Code']]), { id: 'model', name: 'Model', type: 'select', currentValue: currentModel, options: choices }, option('mode', 'Permissions', session.mode, [['code', 'Code · ask for approval'], ['ask', 'Plan only']])];
    const model = models.find(row => row.value === currentModel);
    if (model?.supportsEffort && model.supportedEffortLevels?.length) config.push(option('effort', 'Effort', session.effort || 'auto', [['auto', 'Model default'], ...model.supportedEffortLevels.map(value => [value, value]) ]));
    if (model?.supportsFastMode) config.push(option('fast_mode', 'Fast mode', session.fast ? 'on' : 'off', [['off', 'Off'], ['on', 'On · may cost more']]));
    return config;
  }
  decorate(result) {
    if (!Array.isArray(result?.configOptions)) return result;
    return { ...result, configOptions: result.configOptions.map(item => item.id === 'provider' ? { ...item, options: [...item.options.filter(value => value.value !== 'claude'), { value: 'claude', name: 'Claude Code' }] } : item) };
  }
  update(update, record = true, method = 'session/update') {
    if (record) this.session.updates.push(update);
    this.emit('event', { method, params: { sessionId: this.session.sessionId, update } });
  }
  async request(method, params = {}, options) {
    if (this.closed) throw new Error('Handwork is disconnected');
    if (method === 'initialize') {
      this.background = params.clientCapabilities?.handwork?.backgroundTask === true;
      this.instructions = params.clientCapabilities?.handwork?.responseInstructions;
    }
    if (method === 'handwork/providers/list') {
      const [result, connected] = await Promise.all([this.native.request(method, params, options), this.status()]);
      return { ...result, providers: [...result.providers, { id: 'claude', name: 'Claude Code', signIn: 'none', connected, description: 'Runs your installed Claude Code. Authenticate directly in its CLI with your own account, API key, or supported cloud provider; usage is billed by your provider.' }] };
    }
    if (method === 'session/list') {
      const result = await this.native.request(method, params, options);
      if (params.cursor) return { ...result, sessions: result.sessions.filter(item => !this.read(item.sessionId)?.updates.length) };
      let files; try { files = readdirSync(this.directory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
      const saved = files.filter(file => file.isDirectory() && /^[a-zA-Z0-9_-]{1,128}$/.test(file.name)).map(file => this.read(file.name)).filter(item => item?.updates.length);
      const ids = new Set(saved.map(item => item.sessionId));
      return { ...result, sessions: [...result.sessions.filter(item => !ids.has(item.sessionId)), ...saved.map(({ sessionId, cwd, title, updatedAt }) => ({ sessionId, cwd, title, updatedAt }))] };
    }
    const saved = params.sessionId && ['session/load', 'handwork/session/read', 'session/remove'].includes(method) ? this.read(params.sessionId) : null;
    if (saved) {
      if (method === 'session/remove') {
        await this.native.request(method, params, options);
        try { unlinkSync(this.file(params.sessionId)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (this.session?.sessionId === params.sessionId) this.session = null;
        return { removed: true };
      }
      if (method === 'handwork/session/read') {
        for (const update of saved.updates) this.emit('event', { method: 'handwork/session_read_update', params: { sessionId: saved.sessionId, update } });
        return { sessionId: saved.sessionId, cwd: saved.cwd, title: saved.title, configOptions: this.config(saved) };
      }
      this.session = saved;
      await this.refreshModels();
      for (const update of saved.updates) this.update(update, false);
      return { sessionId: saved.sessionId, configOptions: this.config(), historyReplayed: true };
    }
    if (method === 'session/set_config_option' && params.configId === 'provider' && params.value === 'claude' && !this.session) {
      if (!await this.status()) throw new Error('Sign in with claude auth login in a terminal, then try again.');
      // Existing native history must never silently disappear when changing harnesses.
      const updates = [];
      const collect = event => { if (event.method === 'handwork/session_read_update' && event.params?.sessionId === params.sessionId) updates.push(event.params.update); };
      this.native.on('event', collect);
      try { if (!this.freshSessions.has(params.sessionId)) await this.native.request('handwork/session/read', { sessionId: params.sessionId }); }
      finally { this.native.off('event', collect); }
      if (updates.some(item => item.sessionUpdate === 'user_message_chunk')) throw new Error('Start a new chat to switch to Claude Code. Your current conversation is saved.');
      const models = await this.refreshModels();
      this.session = { sessionId: params.sessionId, cwd: this.options.cwd || process.cwd(), models, model: models[0].value, mode: 'code', updates: [], title: 'New chat', updatedAt: new Date().toISOString() };
      this.save();
      return { configOptions: this.config() };
    }
    if (this.session && params.sessionId === this.session.sessionId) {
      if (method === 'session/set_config_option') {
        if (params.configId === 'provider' && params.value === 'claude') return { configOptions: this.config() };
        if (params.configId === 'model') {
          const models = await this.refreshModels();
          const selected = params.value === 'default' ? this.session.model : params.value;
          if (!models.some(row => row.value === selected)) throw new Error('This model is no longer reported by Claude Code. Refresh the model list.');
          this.session.model = selected; delete this.session.effort; delete this.session.fast;
        }
        else if (params.configId === 'effort') {
          const model = this.session.models?.find(row => row.value === this.session.model);
          if (params.value === 'auto') delete this.session.effort;
          else if (model?.supportsEffort && model.supportedEffortLevels?.includes(params.value)) this.session.effort = params.value;
          else throw new Error('This effort level is not supported by the selected model.');
        }
        else if (params.configId === 'fast_mode') {
          const model = this.session.models?.find(row => row.value === this.session.model);
          if (!model?.supportsFastMode || !['on', 'off'].includes(params.value)) throw new Error('Fast mode is not supported by the selected model.');
          this.session.fast = params.value === 'on';
        }
        else if (params.configId === 'mode' && ['code', 'ask'].includes(params.value)) this.session.mode = params.value;
        else throw new Error('Start a new chat to use another provider.');
        this.save(); return { configOptions: this.config() };
      }
      if (method === 'session/prompt') return this.prompt(params.prompt, options);
      if (method === 'session/rewind') throw new Error('Editing earlier messages is not yet supported for Claude Code chats. Start a new chat instead.');
    }
    if (method === 'session/prompt') this.freshSessions.delete(params.sessionId);
    const result = await this.native.request(method, params, options);
    if (method === 'session/new') this.freshSessions.add(result.sessionId);
    if (method === 'session/prompt') this.freshSessions.delete(params.sessionId);
    return this.decorate(result);
  }
  async prompt(blocks, requestOptions) {
    if (this.controller) throw new Error('Claude Code is busy');
    const content = blocks.map(block => {
      if (block.type === 'text') return { type: 'text', text: block.text };
      if (block.type === 'image' && block.data) return { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } };
      if (block.type === 'resource' && block.resource?.text) return { type: 'text', text: block.resource.text };
      throw new Error('This attachment is not supported by Claude Code. Attach text or an image.');
    });
    await this.status();
    const usageGeneration = claudeUsageGeneration();
    const binary = await this.locate();
    const query = this.query || (await import('@anthropic-ai/claude-agent-sdk')).query;
    const controller = this.controller = new AbortController();
    const timer = requestOptions?.timeout ? setTimeout(() => controller.abort(), requestOptions.timeout) : null;
    const userId = randomUUID();
    for (const block of blocks) this.session.updates.push({ sessionUpdate: 'user_message_chunk', messageId: userId, content: block });
    if (this.session.title === 'New chat') this.session.title = content.find(item => item.type === 'text')?.text.slice(0, 100) || 'Claude Code chat';
    this.update({ sessionUpdate: 'session_info_update', title: this.session.title });
    this.save();
    let completed = false, streamed = false, messageId = randomUUID(), contextUsed, responseModel;
    try {
      const session = this.session;
      async function* input() { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: session.resume || '' }; }
      this.activeQuery = query({ prompt: input(), options: {
        cwd: session.cwd, model: session.model, ...(session.effort ? { effort: session.effort } : {}), resume: session.resume, abortController: controller,
        pathToClaudeCodeExecutable: binary, executable: 'node', permissionMode: session.mode === 'ask' ? 'plan' : 'default', includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        settings: { fastMode: session.fast === true },
        env: { ...process.env, PATH: searchDirectories().join(path.delimiter) },
        ...(this.instructions ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: this.instructions } } : {}),
        canUseTool: (name, input, context) => this.permission(name, input, context),
      } });
      for await (const message of this.activeQuery) {
        if (message.type === 'rate_limit_event') {
          recordClaudeUsage(message.rate_limit_info, usageGeneration);
          this.emit('event', { method: 'desktop/provider-usage', params: { provider: 'claude' } });
        }
        if (message.session_id && session.resume !== message.session_id) { session.resume = message.session_id; this.save(); }
        if (message.parent_tool_use_id) continue;
        if (message.type === 'stream_event') {
          const event = message.event;
          if (event.type === 'message_start') { messageId = event.message.id; streamed = false; }
          if (event.type === 'content_block_delta' && ['text_delta', 'thinking_delta'].includes(event.delta.type)) {
            streamed = true;
            this.update({ sessionUpdate: event.delta.type === 'text_delta' ? 'agent_message_chunk' : 'agent_thought_chunk', messageId, content: { type: 'text', text: event.delta.text || event.delta.thinking } });
          }
        }
        if (message.type === 'assistant' && message.message.usage) {
          const usage = message.message.usage;
          contextUsed = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
          responseModel = message.message.model;
        }
        if (message.type === 'assistant') for (const block of message.message.content) {
          if (!streamed && block.type === 'text') this.update({ sessionUpdate: 'agent_message_chunk', messageId: message.message.id, content: { type: 'text', text: block.text } });
          if (block.type === 'tool_use') this.update({ sessionUpdate: 'tool_call', toolCallId: block.id, title: block.name, rawInput: block.input, status: 'in_progress', kind: block.name === 'Bash' ? 'execute' : 'other' });
        }
        if (message.type === 'user' && Array.isArray(message.message.content)) for (const block of message.message.content) {
          if (block.type === 'tool_result') this.update({ sessionUpdate: 'tool_call_update', toolCallId: block.tool_use_id, status: block.is_error ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) } }] });
        }
        if (message.type === 'assistant' || message.type === 'user') this.save();
        if (message.type === 'result') {
          const modelUsage = message.modelUsage?.[responseModel];
          if (Number.isFinite(contextUsed)) this.update({ sessionUpdate: 'usage_update', used: contextUsed, ...(modelUsage?.contextWindow > 0 ? { size: modelUsage.contextWindow } : {}) });
          if (message.is_error) throw new Error(message.errors?.join('\n') || message.result || 'Claude Code could not finish the response.');
          completed = true;
        }
      }
      if (!completed && !controller.signal.aborted) throw new Error('Claude Code stopped before completing its response.');
      return { stopReason: controller.signal.aborted ? 'cancelled' : 'end_turn' };
    } catch (error) { if (controller.signal.aborted) return { stopReason: 'cancelled' }; throw error; }
    finally { clearTimeout(timer); this.cancelPermissions(); this.activeQuery?.close(); this.activeQuery = null; this.controller = null; this.session.updatedAt = new Date().toISOString(); this.save(); }
  }
  permission(name, input, { signal, toolUseID }) {
    if (name === 'AskUserQuestion') return Promise.resolve({ behavior: 'deny', message: 'Ask the user your question in your reply and wait for their next message.' });
    return new Promise(resolve => {
      const id = `claude:${randomUUID()}`;
      const finish = allowed => { signal.removeEventListener('abort', abort); this.permissions.delete(id); resolve(allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Permission denied by the user.' }); };
      const abort = () => finish(false);
      if (signal.aborted) return finish(false);
      this.permissions.set(id, finish); signal.addEventListener('abort', abort, { once: true });
      this.emit('event', { method: 'session/request_permission', id, params: { sessionId: this.session.sessionId, toolCall: { toolCallId: toolUseID, title: name, rawInput: input }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } });
    });
  }
  respondPermission(id, optionId) {
    if (this.permissions.has(id)) { if (![null, 'allow', 'deny'].includes(optionId)) throw new Error('Unknown permission option'); this.permissions.get(id)(optionId === 'allow'); }
    else this.native.respondPermission(id, optionId);
  }
  cancelPermissions() { for (const finish of this.permissions.values()) finish(false); this.native.cancelPermissions(); }
  send(message) { if (message.method === 'session/cancel' && this.controller) { this.cancelPermissions(); this.controller.abort(); } else this.native.send(message); }
  dispose() { this.closed = true; this.cancelPermissions(); this.controller?.abort(); this.activeQuery?.close(); this.native.dispose(); }
}
