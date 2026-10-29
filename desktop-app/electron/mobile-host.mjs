import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { hostname, networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';

/** Private stdio RPC; no localhost HTTP endpoint or renderer access to identities. */
export class MobileTransport {
  constructor(binary, onEvent, onExit = () => {}) {
    this.pending = new Map(); this.sequence = 0;
    this.child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.on('data', bytes => console.error(`Mobile transport: ${bytes}`));
    this.child.stdin.on('error', () => {});
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let value; try { value = JSON.parse(line); } catch { return; }
      if (value.event) { onEvent(value); return; }
      const pending = this.pending.get(value.id); if (!pending) return;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      if (value.ok) pending.resolve(value.result); else pending.reject(new Error(value.error));
    });
    const failed = error => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear(); onExit(error);
    };
    this.child.once('error', failed);
    this.child.once('exit', () => failed(new Error('Mobile transport stopped. Restart desktop to reconnect.')));
  }
  call(op, params = {}) {
    if (this.closed) return Promise.reject(new Error('Mobile transport is unavailable'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Mobile transport timed out')); }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...params }) + '\n');
    });
  }
  reply(requestId, response) { if (!this.closed) this.child.stdin.write(JSON.stringify({ op: 'reply', requestId, response }) + '\n'); }
  dispose() { this.child.stdin.end(); this.child.kill(); this.lines.close(); }
}

export class MobileHost {
  constructor({ binary, directory, safeStorage, workspace, transportFactory = (...args) => new MobileTransport(...args) }) {
    this.directory = directory; this.safeStorage = safeStorage; this.workspace = workspace;
    this.config = { enabled: false, remoteAddress: '', devices: [] };
    this.invitation = null; this.watches = new Map(); this.commands = new Map(); this.listening = false;
    this.file = path.join(directory, 'electron-mobile.json');
    try { this.config = JSON.parse(readFileSync(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.transport = transportFactory(binary, event => { void this.event(event); }, error => { this.listening = false; this.error = error.message; this.clearWatches(); });
    this.ready = this.config.enabled ? this.start() : Promise.resolve();
    this.ready.catch(error => { this.error = error.message; });
  }
  save() {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify(this.config), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }
  async start() {
    if (this.listening) return;
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Unlock your OS keychain before enabling mobile access.');
    let identity;
    if (this.config.identity) identity = JSON.parse(this.safeStorage.decryptString(Buffer.from(this.config.identity, 'base64')));
    else {
      const generated = await this.transport.call('identity'); identity = generated.identity;
      this.config.identity = this.safeStorage.encryptString(JSON.stringify(identity)).toString('base64');
      this.config.fingerprint = generated.fingerprint; this.save();
    }
    for (const device of this.config.devices) await this.transport.call('allow', { fingerprint: device.fingerprint });
    await this.transport.call('start', { identity }); this.listening = true; this.error = undefined;
  }
  addresses() {
    const addresses = Object.values(networkInterfaces()).flat().filter(v => v && !v.internal && !v.address.includes('%') && !v.address.startsWith('fe80:')).map(v => ({ host: v.address, port: 38416 }));
    if (this.config.remoteAddress) addresses.unshift(parseAddress(this.config.remoteAddress));
    return addresses.filter((v, i, all) => all.findIndex(x => x.host === v.host && x.port === v.port) === i).slice(0, 16);
  }
  status() { return { enabled: this.config.enabled, listening: this.listening, devices: this.config.devices.map(({ id, name }) => ({ id, name })), addresses: this.addresses(), remoteAddress: this.config.remoteAddress, error: this.error }; }
  async configure({ enabled, remoteAddress = '' }) {
    await this.ready.catch(() => {});
    if (remoteAddress.trim()) parseAddress(remoteAddress);
    if (enabled) await this.start();
    else { await this.cancelInvite(); await this.transport.call('stop'); this.listening = false; this.clearWatches(); }
    this.config.enabled = enabled; this.config.remoteAddress = remoteAddress.trim(); this.save();
    return this.status();
  }
  async cancelInvite() { if (this.invitation) { await this.transport.call('revoke', { fingerprint: this.invitation.fingerprint }); this.invitation = null; } }
  async invite() {
    await this.ready;
    if (!this.config.enabled || !this.listening) throw new Error('Enable mobile access first');
    await this.cancelInvite();
    const addresses = this.addresses(); if (!addresses.length) throw new Error('Connect to a network before pairing.');
    const join = await this.transport.call('identity'); const expires = Math.floor(Date.now() / 1000) + 900;
    await this.transport.call('allow', { fingerprint: join.fingerprint, expires });
    this.invitation = { fingerprint: join.fingerprint, expires };
    const invitation = { version: 1, name: hostname(), fingerprint: this.config.fingerprint, addresses, identity: join.identity, expires };
    return { url: `handwork://pair?i=${Buffer.from(JSON.stringify(invitation)).toString('base64url')}`, expires };
  }
  async revoke(id) {
    const device = this.config.devices.find(v => v.id === id);
    if (device) await this.transport.call('revoke', { fingerprint: device.fingerprint });
    this.config.devices = this.config.devices.filter(v => v.id !== id); this.save();
    for (const [key, watch] of this.watches) if (watch.peer === device?.fingerprint) { clearInterval(watch.timer); this.watches.delete(key); }
    return this.status();
  }
  async handle(peer, request) {
    if (!this.config.enabled || !this.listening) throw new Error('Mobile access disabled');
    if (request.version !== 1 || !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw new Error('Invalid mobile request');
    if (request.method === 'device.enroll') {
      // Consume before awaiting verification so concurrent enrollment cannot reuse a code.
      const invitation = this.invitation;
      if (!invitation || invitation.fingerprint !== peer || invitation.expires <= Date.now() / 1000) throw new Error('Invitation expired or already used');
      this.invitation = null;
      await this.transport.call('revoke', { fingerprint: peer });
      const fingerprint = await this.transport.call('verify', { peer, certificate: request.params.certificate, proof: request.params.proof });
      const device = { id: randomUUID(), name: String(request.params.name || 'Phone').slice(0, 80), fingerprint };
      this.config.devices = [...this.config.devices.filter(v => v.fingerprint !== fingerprint), device]; this.save();
      await this.transport.call('allow', { fingerprint });
      return { deviceId: device.id, name: hostname(), fingerprint: this.config.fingerprint, addresses: this.addresses() };
    }
    if (!this.config.devices.some(v => v.fingerprint === peer)) throw new Error('Device revoked or not paired');
    if (request.method === 'device.leave') { const device = this.config.devices.find(v => v.fingerprint === peer); await this.revoke(device.id); return {}; }
    if (typeof request.id !== 'string' || !request.id || request.id.length > 256) throw new Error('Missing command ID');
    const perform = () => this.workspace.handle(request.method, request.params).then(result => request.method === 'workspace.list' ? { ...result, addresses: this.addresses() } : result);
    // Polls and transcripts must stay fresh and must not accumulate in the retry cache.
    if (!['session.start', 'conversation.send', 'session.configure', 'session.cancel', 'session.rename', 'session.archive', 'session.delete', 'project.gitAction'].includes(request.method)) return perform();
    const key = `${peer}:${request.id}`;
    // Cache both success and failure so a retry never submits the same prompt twice.
    if (!this.commands.has(key)) {
      if (this.commands.size >= 2000) this.commands.delete(this.commands.keys().next().value);
      this.commands.set(key, Promise.resolve().then(perform));
    }
    return this.commands.get(key);
  }
  async event(event) {
    if (event.event === 'unwatch') { const watch = this.watches.get(event.watchId); if (watch) clearInterval(watch.timer); this.watches.delete(event.watchId); return; }
    try {
      if (event.event === 'watch') {
        if (event.request.method !== 'conversation.watch') throw new Error('Unsupported watch');
        if ([...this.watches.values()].filter(v => v.peer === event.peer).length >= 4) throw new Error('Too many open conversations');
        const request = { ...event.request, method: 'conversation.read' };
        const initial = await this.handle(event.peer, request);
        const watch = { peer: event.peer, running: false, previous: '', timer: null };
        const push = async (value) => {
          if (watch.running) return; watch.running = true;
          try {
            const data = value ?? await this.workspace.handle('conversation.read', request.params);
            const frame = { ...data, order: data.turns.map(t => t.id), older: data.older ?? false };
            const encoded = JSON.stringify(frame);
            if (encoded !== watch.previous) { await this.transport.call('push', { watchId: event.requestId, update: frame }); watch.previous = encoded; }
          } catch (error) { await this.transport.call('push', { watchId: event.requestId, update: { error: error.message } }).catch(() => {}); }
          finally { watch.running = false; }
        };
        this.watches.set(event.requestId, watch);
        this.transport.reply(event.requestId, { ok: true, result: null });
        watch.timer = setInterval(() => void push(), 200); watch.timer.unref?.();
        await push(initial);
      } else this.transport.reply(event.requestId, { ok: true, result: await this.handle(event.peer, event.request) });
    } catch (error) { this.transport.reply(event.requestId, { ok: false, error: error.message }); }
  }
  clearWatches() { for (const watch of this.watches.values()) clearInterval(watch.timer); this.watches.clear(); }
  dispose() { this.clearWatches(); this.transport.dispose(); }
}
export function parseAddress(value) {
  if (typeof value !== 'string' || !value.trim() || /[\s/?#@]/.test(value.trim())) throw new Error('Enter a hostname or IP address with an optional UDP port');
  const parsed = new URL(`https://${value.trim()}`);
  const port = parsed.port ? Number(parsed.port) : 38416;
  if (!parsed.hostname || port < 1 || port > 65535) throw new Error('Invalid remote address');
  return { host: parsed.hostname.replace(/^\[|\]$/g, ''), port };
}
