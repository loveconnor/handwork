import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MAX_FRAME = 8 * 1024 * 1024;
const MAX_WRITE = 2 * MAX_FRAME;
const validId = (id) => typeof id === 'string' || Number.isSafeInteger(id);

// Private main-process transport. Never expose request() to the renderer.
export class AcpClient extends EventEmitter {
  constructor({ binary, cwd, args = ['acp'], env = process.env, requestTimeout = 30_000, maxFrame = MAX_FRAME }) {
    super();
    this.pending = new Map();
    this.permissions = new Map();
    this.nextId = 1;
    this.closed = false;
    this.stderr = '';
    this.buffer = Buffer.alloc(0);
    this.requestTimeout = requestTimeout;
    this.maxFrame = maxFrame;
    this.child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.exited = new Promise((resolve) => this.child.once('close', resolve));
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-16_384); });
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.on('error', (error) => this.fail(error));
    this.child.stderr.on('error', (error) => this.fail(error));
    this.child.stdout.on('end', () => { if (!this.closed) this.fail(new Error('Handwork stdout closed')); });
    this.child.on('exit', (code, signal) => {
      clearTimeout(this.killTimer);
      if (!this.closed) this.fail(new Error(`Handwork exited (${signal ?? code})`));
    });
  }

  send(message) {
    if (this.closed) throw new Error('Handwork is disconnected');
    const frame = JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n';
    if (Buffer.byteLength(frame) > this.maxFrame || this.child.stdin.writableLength + Buffer.byteLength(frame) > MAX_WRITE) {
      const error = new Error('Handwork input limit exceeded');
      this.fail(error);
      throw error;
    }
    this.child.stdin.write(frame);
  }

  request(method, params, { timeout = this.requestTimeout } = {}) {
    if (this.closed) return Promise.reject(new Error('Handwork is disconnected'));
    if (this.pending.size >= 64) return Promise.reject(new Error('Too many pending requests'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => this.fail(new Error(`Handwork ${method} timed out`)), timeout) : null;
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  consume(chunk) {
    if (this.closed) return;
    // Split before concatenating so a large batch of small frames stays bounded.
    let start = 0;
    while (start < chunk.length && !this.closed) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (this.buffer.length + part.length > this.maxFrame) return this.fail(new Error('Handwork output frame limit exceeded'));
      this.buffer = Buffer.concat([this.buffer, part]);
      if (end < 0) return;
      const line = this.buffer.toString('utf8');
      this.buffer = Buffer.alloc(0);
      start = end + 1;
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.fail(new Error(`Invalid Handwork output: ${error.message}`)); }
    }
  }

  receive(message) {
    if (!message || message.jsonrpc !== '2.0' || Array.isArray(message)) throw new Error('Expected JSON-RPC object');
    if (typeof message.method === 'string') {
      if ('result' in message || 'error' in message) throw new Error('Invalid request');
      if ('id' in message) {
        if (!validId(message.id)) throw new Error('Invalid request ID');
        if (message.method !== 'session/request_permission') {
          this.send({ id: message.id, error: { code: -32601, message: 'Client method not supported' } });
          return;
        }
        const params = message.params;
        if (!params || typeof params.sessionId !== 'string' || !Array.isArray(params.options) ||
            !params.options.every((option) => option && typeof option.optionId === 'string')) {
          this.send({ id: message.id, error: { code: -32602, message: 'Invalid permission request' } });
          return;
        }
        if (this.permissions.has(message.id)) throw new Error('Duplicate permission request ID');
        if (this.permissions.size >= 32) {
          this.send({ id: message.id, result: { outcome: { outcome: 'cancelled' } } });
          return;
        }
        this.permissions.set(message.id, params);
        this.emit('event', { method: message.method, id: message.id, params });
      } else if (message.method === 'session/update' || message.method === 'handwork/session_read_update') {
        this.emit('event', { method: message.method, params: message.params });
      }
      return;
    }
    if (!validId(message.id) || (('result' in message) === ('error' in message))) throw new Error('Invalid response');
    const pending = this.pending.get(message.id);
    if (!pending) return; // Late response after cancellation/teardown.
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ('error' in message) pending.reject(new Error(message.error?.message || 'Handwork request failed'));
    else pending.resolve(message.result);
  }

  respondPermission(id, optionId) {
    const permission = this.permissions.get(id);
    if (!permission) throw new Error('Unknown permission request');
    if (optionId !== null && !permission.options.some((option) => option.optionId === optionId)) throw new Error('Unknown permission option');
    this.send({ id, result: { outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } } });
    this.permissions.delete(id);
  }

  cancelPermissions() {
    for (const id of this.permissions.keys()) this.respondPermission(id, null);
  }

  fail(error) {
    if (this.closed) return;
    this.dispose(error);
    this.emit('event', { method: 'engine/error', params: { message: error.message } });
  }

  dispose(error = new Error('Handwork disconnected')) {
    if (this.closed || this.disposing) return;
    this.disposing = true;
    try { this.cancelPermissions(); } catch { /* Pipe may already be gone. */ }
    this.closed = true;
    this.permissions.clear();
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 1500);
      this.killTimer.unref();
    }
  }
}
