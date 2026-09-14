import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class CodexRuntime {
  constructor({ executable = process.env.HANDWORK_CODEX_PATH || 'codex', cwd = process.cwd(), approve = async () => false, question = async () => '', output = text => process.stdout.write(text) } = {}) {
    Object.assign(this, { executable, cwd, approve, question, output });
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Set();
  }
  async start() {
    this.child = spawn(this.executable, ['app-server'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex runtime exited (${signal || code})`)));
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => {
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) return this.fail(new Error('Codex event exceeds limit'));
      try { this.receive(JSON.parse(line)); } catch (error) { this.fail(error); }
    });
    await this.request('initialize', { clientInfo: { name: 'handwork', title: 'Handwork', version: '0.0.9' } });
    this.send({ method: 'initialized', params: {} });
  }
  send(message) { this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params = {}, timeout = 30_000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  receive(message) {
    if (message.method && message.id !== undefined) {
      this.serverRequest(message).catch(error => this.fail(error));
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    } else {
      for (const listener of [...this.listeners]) listener(message);
    }
  }
  async serverRequest({ id, method, params }) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const accepted = await this.approve({ method, ...params });
      this.send({ id, result: { decision: accepted ? 'accept' : 'decline' } });
    } else if (method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const q of params.questions || []) answers[q.id] = { answers: [await this.question(q.question)] };
      this.send({ id, result: { answers } });
    } else {
      // New protocol features must never turn into implicit permission grants.
      this.send({ id, error: { code: -32601, message: `Unsupported Handwork request: ${method}` } });
    }
  }
  waitFor(method, predicate = () => true, timeout = 600_000) {
    let listener;
    let timer;
    let rejectWait;
    const promise = new Promise((resolve, reject) => {
      rejectWait = reject;
      listener = message => {
        if (message.method === '__failure') { cleanup(); reject(message.error); }
        else if (message.method === method && predicate(message.params)) { cleanup(); resolve(message.params); }
      };
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(listener); };
      timer = setTimeout(() => { cleanup(); reject(new Error(`${method} timed out`)); }, timeout);
      this.listeners.add(listener);
    });
    // Register a handler immediately so startup failures cannot cause an unhandled rejection.
    promise.catch(() => {});
    return { promise, cancel: () => { clearTimeout(timer); this.listeners.delete(listener); rejectWait(new Error('Cancelled')); } };
  }
  async login() {
    const completed = this.waitFor('account/login/completed');
    try {
      const login = await this.request('account/login/start', { type: 'chatgpt' });
      this.output(`Complete the official Codex login in your browser:\n${login.authUrl}\n`);
      const result = await completed.promise;
      if (!result.success) throw new Error(result.error || 'Codex login failed');
      this.output('Codex subscription connected.\n');
    } finally { completed.cancel(); }
  }
  async models() { return (await this.request('model/list', {})).data; }
  async ask(prompt, { model, resume } = {}) {
    const account = await this.request('account/read', {});
    if (account.account?.type !== 'chatgpt') throw new Error('A ChatGPT subscription login is required. Run handwork runtime codex login.');
    const params = { cwd: this.cwd, approvalPolicy: 'on-request', sandbox: 'workspaceWrite', ...(model ? { model } : {}) };
    const response = await this.request(resume ? 'thread/resume' : 'thread/start', resume ? { ...params, threadId: resume } : params);
    const threadId = response.thread.id;
    this.threadId = threadId;
    const listener = message => {
      if (message.params?.threadId !== threadId) return;
      if (message.method === 'item/agentMessage/delta') this.output(message.params.delta || '');
      if (message.method === 'turn/started') this.turnId = message.params.turn?.id;
    };
    this.listeners.add(listener);
    const completed = this.waitFor('turn/completed', params => params.threadId === threadId, 60 * 60 * 1000);
    try {
      const turn = await this.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      this.turnId = turn.turn.id;
      const result = await completed.promise;
      if (result.turn.status !== 'completed') throw new Error(result.turn.error?.message || `Codex turn ${result.turn.status}`);
      this.output('\n');
      return threadId;
    } finally { completed.cancel(); this.listeners.delete(listener); this.turnId = null; }
  }
  async interrupt() { if (this.threadId && this.turnId) await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, 3000); }
  fail(error) {
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of [...this.listeners]) listener({ method: '__failure', error });
  }
  async stop() {
    this.fail(new Error('Codex runtime stopped'));
    this.lines?.close();
    this.child?.stdin.end();
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
      const child = this.child;
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
      timer.unref();
    }
  }
}
