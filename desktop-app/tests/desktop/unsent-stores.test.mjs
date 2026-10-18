import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlobStore } from '../../electron/blob-store.mjs';
import { DraftStore } from '../../electron/draft-store.mjs';
import { QueueStore } from '../../electron/queue-store.mjs';

const file = text => ({ name: 'note.txt', mimeType: 'text/plain', size: text.length, text });

test('blob quota counts existing and repeated hashes once on disk and in memory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-blobs-'));
  try {
    for (const directory of [null, root]) {
      const blobs = new BlobStore(directory, 6);
      assert.equal(blobs.encode([file('abc')]).skipped, 0);
      assert.equal(blobs.canFit([file('abc'), file('abc'), file('def')]), true);
      const encoded = blobs.encode([file('abc'), file('abc'), file('def')]);
      assert.equal(encoded.skipped, 0);
      assert.equal(encoded.saved.length, 3);
      assert.equal(blobs.bytes(), 6);
      assert.equal(blobs.encode([file('x')]).skipped, 1);
      assert.equal(blobs.bytes(), 6);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('non-evicting store saves reject byte overflow atomically, including replacements', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-stores-'));
  try {
    for (const Store of [DraftStore, QueueStore]) {
      const store = new Store(path.join(root, Store.name));
      const save = (key, files, options) => Store === DraftStore ? store.save(key, '', files, options)
        : store.save(key, { paused: true, items: files.map((f, i) => ({ id: String(i), text: '', files: [f] })) }, options);
      store.blobs.limit = 6;
      save('local', [file('abc')]);
      const before = store.read();
      const blobs = await readdir(store.blobs.directory);
      for (const key of ['incoming', 'local']) {
        assert.equal(save(key, [file('xy'), file('zzzz')], { evict: false }).saved, false);
        assert.deepEqual(store.read(), before);
        assert.deepEqual(await readdir(store.blobs.directory), blobs);
      }
      assert.equal(save('incoming', [file('abc'), file('def')], { evict: false }).saved, true);
      assert.equal(store.blobs.bytes(), 6);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('draft moves preserve serialized blobs at full count and byte quotas and refuse occupied targets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-draft-move-'));
  try {
    const store = new DraftStore(root);
    store.save('source', 'recover me', [file('abc')]);
    const records = store.read();
    for (let i = 0; i < 199; i++) records[`local-${i}`] = { text: 'keep', files: [], updatedAt: i };
    store.write(records);
    store.blobs.limit = 3;
    const before = store.read();
    const manifest = await readFile(store.index);
    const blobs = await readdir(store.blobs.directory);
    store.blobs.encode = () => { throw new Error('must not re-encode'); };
    assert.deepEqual(store.move('source', 'local-0'), { saved: false, skipped: 0 });
    assert.deepEqual(await readFile(store.index), manifest);
    assert.deepEqual(store.move('missing', 'target'), { saved: false, skipped: 0 });
    assert.deepEqual(store.move('source', 'source'), { saved: true, skipped: 0 });
    assert.deepEqual(store.move('source', 'recovered'), { saved: true, skipped: 0 });
    const after = new DraftStore(root).read();
    assert.equal(Object.keys(after).length, 200);
    assert.equal(Object.hasOwn(after, 'source'), false);
    assert.deepEqual(after.recovered, before.source);
    for (let i = 0; i < 199; i++) assert.deepEqual(after[`local-${i}`], before[`local-${i}`]);
    assert.deepEqual(await readdir(store.blobs.directory), blobs);
    assert.equal(new DraftStore(root).list().find(draft => draft.id === 'recovered').files[0].text, 'abc');
    const write = store.write.bind(store);
    store.write = () => { throw new Error('manifest failed'); };
    assert.throws(() => store.move('recovered', 'retry'), /manifest failed/);
    assert.deepEqual(new DraftStore(root).read(), after);
    store.write = write;
    const empty = store.read(); empty.empty = { text: ' ', files: [], updatedAt: 0 }; store.write(empty);
    assert.equal(store.move('recovered', 'empty').saved, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
