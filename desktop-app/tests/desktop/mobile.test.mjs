import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MobileHost, parseAddress } from '../../electron/mobile-host.mjs';
import { MobileWorkspace, mobileTurns } from '../../electron/mobile-workspace.mjs';
import { applyFrames } from '../../mobile/src/features/workspace/watchUpdates.ts';
import { parseInvitation } from '../../mobile/src/features/connection/invitation.ts';

test('Electron invitations parse in the unchanged phone app; enrollment is single-use and revocation removes access', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mobile-host-'));
  const calls = []; let serial = 0; let requests = 0;
  const transport = { async call(op, args) { calls.push([op, args]); if (op === 'identity') return { fingerprint: (++serial).toString(16).padStart(64, '0'), identity: { certificate: 'cert', privateKey: 'key' } }; if (op === 'verify') return 'd'.repeat(64); }, dispose() {} };
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: v => Buffer.from(v), decryptString: v => v.toString() };
  const host = new MobileHost({ directory, binary: '', safeStorage, workspace: { async handle() { requests++; return { projects: [], monos: [], sessions: [] }; } }, transportFactory: () => transport });
  try {
    await host.configure({ enabled: true, remoteAddress: '127.0.0.1:38416' });
    const invitation = parseInvitation((await host.invite()).url);
    assert.equal(invitation.fingerprint, '1'.padStart(64, '0'));
    const peer = '2'.padStart(64, '0');
    const request = { version: 1, id: 'pair', method: 'device.enroll', params: { certificate: 'cert', proof: 'proof', name: 'Phone' } };
    const device = await host.handle(peer, request);
    await assert.rejects(host.handle(peer, request), /already used/);
    await assert.rejects(host.handle('unknown', { ...request, method: 'workspace.list' }), /not paired/);
    const read = { ...request, id: 'send', method: 'conversation.send', params: {} };
    await Promise.all([host.handle('d'.repeat(64), read), host.handle('d'.repeat(64), read)]);
    assert.equal(requests, 1, 'retries share the same operation');
    await host.revoke(device.deviceId);
    await assert.rejects(host.handle('d'.repeat(64), { ...read, id: 'after-revoke' }), /not paired/);
    await host.configure({ enabled: false, remoteAddress: '' });
    await assert.rejects(host.invite(), /Enable/);
    assert.ok(calls.some(([op]) => op === 'stop'));
  } finally { host.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('phone applies Electron transcript frames as replies stream and finish', () => {
  const updates = [
    { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Hello' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } },
  ];
  const first = mobileTurns(updates, true);
  let result = applyFrames([], [{ busy: true, turns: first, order: first.map(t => t.id) }]);
  assert.equal(result.turns[0].items[1].text, 'Hi');
  updates.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' there' } });
  const finished = mobileTurns(updates, false);
  result = applyFrames(result.turns, [{ busy: false, turns: finished, order: finished.map(t => t.id) }]);
  assert.equal(result.turns.length, 1); assert.equal(result.turns[0].copyText, 'Hi there'); assert.equal(result.busy, false);
});

test('mobile reads the Electron catalog, streams events, sends to the selected session, and blocks file escapes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mobile-workspace-'));
  const project = path.join(root, 'project'); await mkdir(project); await writeFile(path.join(project, 'hello.txt'), 'Hello'); await writeFile(path.join(root, 'secret'), 'secret'); await symlink(path.join(root, 'secret'), path.join(project, 'outside'));
  const engine = { session: { sessionId: 's1', configOptions: [] }, workspace: project, client: { closed: false }, prompting: false };
  const backend = Object.assign(new EventEmitter(), { workspace: project, engines: new Set([engine]), projects: { list: () => [project] }, listSessions: async () => {}, listCachedSessions: () => ({ sessions: [{ sessionId: 's1', cwd: project, title: 'Shared chat', updatedAt: 1 }] }), readSession: async () => ({ updates: [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hello' } }] }), prompt: async (text, attachments, id) => { assert.equal(id, 's1'); engine.prompting = true; backend.emit('event', { method: 'session/update', params: { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Live reply' } } } }); }, cancel: async () => { engine.prompting = false; } });
  const workspace = new MobileWorkspace(backend);
  try {
    const catalog = await workspace.handle('workspace.list', {}); const projectId = catalog.projects.find(p => p.path === project).id;
    assert.equal(catalog.projects[0].kind, 'chats'); assert.equal(catalog.sessions[0].title, 'Shared chat');
    await workspace.handle('conversation.send', { conversationId: 's1', text: 'Hi' });
    const conversation = await workspace.handle('conversation.read', { conversationId: 's1' });
    assert.equal(conversation.busy, true); assert.equal(conversation.turns[0].copyText, 'Live reply');
    assert.equal((await workspace.handle('project.file', { projectId, path: 'hello.txt' })).text, 'Hello');
    await assert.rejects(workspace.handle('project.file', { projectId, path: '../secret' }), /outside/);
    await assert.rejects(workspace.handle('project.file', { projectId, path: 'outside' }), /outside/);
    await assert.rejects(workspace.handle('conversation.send', { conversationId: '../secret', text: 'Hi' }), /Invalid/);
    await workspace.handle('session.cancel', { conversationId: 's1' }); assert.equal(engine.prompting, false);
  } finally { workspace.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('mobile access refuses unencrypted key storage and validates remote addresses', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mobile-storage-'));
  const host = new MobileHost({ directory, safeStorage: { isEncryptionAvailable: () => false }, transportFactory: () => ({ dispose() {} }) });
  try { await assert.rejects(host.configure({ enabled: true }), /keychain/); } finally { host.dispose(); await rm(directory, { recursive: true, force: true }); }
  assert.deepEqual(parseAddress('[::1]:4000'), { host: '::1', port: 4000 });
  for (const input of ['user@host', 'https://host', 'host/path', 'host:0']) assert.throws(() => parseAddress(input));
});
