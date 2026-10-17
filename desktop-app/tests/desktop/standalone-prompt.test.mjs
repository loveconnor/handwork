import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generateSystemPrompt, honestChatSpec } from 'honestui/genui/server';
import { DesktopBackend } from '../../electron/backend.mjs';

const desktopPrompt = JSON.parse(readFileSync(new URL('../../electron/genui-prompt.json', import.meta.url)));
const playgroundPrompt = generateSystemPrompt({ library: honestChatSpec });
const standalonePrompt = JSON.parse(readFileSync(new URL('../../electron/standalone-prompt.json', import.meta.url)));

test('standalone chats keep the playground prompt with math formatting guidance, including when reopened', async () => {
  assert.ok(standalonePrompt.startsWith(playgroundPrompt + '\n\n'));
  for (const prompt of [standalonePrompt, desktopPrompt]) {
    assert.ok(prompt.includes(String.raw`\cdot`));
    assert.ok(prompt.includes(String.raw`\qquad\text{(IH)}`));
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'handwork-prompt-'));
  const requests = [];
  const backend = new DesktopBackend({
    chatDirectory: directory,
    clientFactory() {
      const client = new EventEmitter();
      client.exited = new Promise(() => {});
      client.dispose = () => {};
      client.request = async (method, params) => {
        requests.push({ method, params });
        return { protocolVersion: 1, agentCapabilities: { handwork: { standaloneChat: true } } };
      };
      return client;
    },
  });
  try {
    const fresh = await backend.openEngine('');
    await backend.openEngine(fresh.directory);
    await backend.openEngine('/project');
    const capabilities = requests.map(({ params }) => params.clientCapabilities.handwork);
    assert.equal(capabilities[0].responseInstructions, standalonePrompt);
    assert.equal(capabilities[1].responseInstructions, standalonePrompt);
    assert.equal(capabilities[0].standaloneChat, true);
    assert.equal(capabilities[1].standaloneChat, true);
    assert.equal(capabilities[2].responseInstructions, desktopPrompt);
    assert.equal(capabilities[2].standaloneChat, undefined);
    assert.notEqual(playgroundPrompt, desktopPrompt);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('standalone chats still require native isolation support', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'handwork-prompt-'));
  let disposed = false;
  const backend = new DesktopBackend({
    chatDirectory: directory,
    clientFactory() {
      const client = new EventEmitter();
      client.exited = new Promise(() => {});
      client.dispose = () => { disposed = true; };
      client.request = async () => ({ protocolVersion: 1 });
      return client;
    },
  });
  try {
    await assert.rejects(backend.openEngine(''), /Rebuild the Handwork engine/);
    assert.equal(disposed, true);
    assert.equal(backend.engines.size, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
