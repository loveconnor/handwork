import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DesktopUpdater } from '../../electron/updater.mjs';
import { UpdateDraftStore } from '../../electron/update-drafts.mjs';
import { validateArguments } from '../../electron/ipc.mjs';

function fixture(options = {}) {
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => { updater.emit('update-available', { version: '0.1.2' }); };
  updater.downloadUpdate = async () => { updater.emit('download-progress', { percent: 51 }); updater.emit('update-downloaded', { version: '0.1.2' }); };
  updater.quitAndInstall = (...args) => { updater.installed = args; };
  const service = new DesktopUpdater({ updater, available: true, ...options });
  return { service, updater };
}

test('checking, downloading, and installing are distinct user actions and restart is blocked while busy', async () => {
  let busy = true;
  let saved;
  const { service, updater } = fixture({ isBusy: () => busy, beforeInstall: async drafts => { saved = drafts; } });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  await assert.rejects(service.install([]), /Download the update/);
  assert.equal((await service.check()).status, 'available');
  assert.equal(updater.installed, undefined);
  assert.equal((await service.download()).status, 'downloaded');
  await assert.rejects(service.install([]), /Finish or stop/);
  assert.equal(service.snapshot().status, 'downloaded');
  busy = false;
  const drafts = [{ id: 'chat-id', text: 'unfinished message', files: [] }];
  await service.install(drafts);
  assert.deepEqual(saved, drafts);
  assert.deepEqual(updater.installed, [true, true]);
});

test('failed checks can be retried, duplicate checks are coalesced, and unavailable builds stay quiet', async () => {
  const { service, updater } = fixture();
  let attempts = 0;
  updater.checkForUpdates = () => { attempts++; throw new Error('offline'); };
  await Promise.all([service.check(), service.check()]);
  assert.equal(attempts, 1);
  assert.equal(service.snapshot().status, 'error');
  await service.check();
  assert.equal(attempts, 2);
  const unavailable = new DesktopUpdater({ updater, available: false, unavailableReason: 'Unsigned Mac build' });
  unavailable.start();
  await unavailable.check();
  assert.equal(attempts, 2);
  assert.equal(unavailable.snapshot().status, 'unavailable');
});

test('download failures can be retried and draft-save failure never starts an installer', async () => {
  const { service, updater } = fixture({ beforeInstall: async () => { throw new Error('disk full'); } });
  await service.check();
  updater.downloadUpdate = async () => { throw new Error('network lost'); };
  assert.equal((await service.download()).status, 'error');
  updater.downloadUpdate = async () => updater.emit('update-downloaded', { version: '0.1.2' });
  await service.download();
  await assert.rejects(service.install([]), /disk full/);
  assert.equal(updater.installed, undefined);
  assert.equal(service.snapshot().status, 'downloaded');
});

test('update drafts preserve text and attachments once, and IPC rejects arbitrary update inputs', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'handwork-update-drafts-'));
  try {
    const file = path.join(directory, 'drafts.json');
    const store = new UpdateDraftStore(file);
    const drafts = [{ id: 'chat-id', text: 'unfinished message', files: [{ name: 'note.txt', mimeType: 'text/plain', text: 'attachment content' }] }];
    store.save(drafts);
    assert.deepEqual(store.take(), drafts);
    assert.equal(existsSync(file), false);
    assert.deepEqual(store.take(), []);
    validateArguments('installUpdate', [drafts]);
    assert.throws(() => validateArguments('installUpdate', [{ url: 'https://untrusted.test/update.exe' }]), /Invalid desktop API/);
    assert.throws(() => validateArguments('downloadUpdate', ['/arbitrary/path']), /Invalid desktop API/);
    assert.throws(() => store.save([{ id: 'x', text: 'x', files: [{ name: 'bad', mimeType: 'text/plain', data: 'not base64' }] }]), /Save large drafts/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
