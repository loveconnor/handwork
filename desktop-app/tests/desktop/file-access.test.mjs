import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileAccess } from '../../electron/file-access.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'handwork-file-access-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  await mkdir(project);
  await mkdir(outside);
  const opened = [];
  const options = { roots: () => [project], shell: { openPath: async file => { opened.push(file); return ''; } } };
  return { root, project, outside, opened, options };
}

// Override only describe's boundary, after authorization and before preview
// opens the file. No timing-dependent race loops or scripts are executed.
function replacingAccess(options, replace) {
  return new class extends FileAccess {
    async describe(...args) {
      const description = await super.describe(...args);
      await replace(description);
      return description;
    }
  }(options);
}

for (const extension of ['.txt', '.png']) {
  test(`preview rejects a final symlink replacement for ${extension}`, async t => {
    const { project, outside, options } = await fixture(t);
    const file = path.join(project, `note${extension}`);
    const secret = path.join(outside, `secret${extension}`);
    await writeFile(file, 'safe');
    await writeFile(secret, 'private');
    const files = replacingAccess(options, async () => {
      await rename(file, `${file}.original`);
      await symlink(secret, file);
    });
    await assert.rejects(files.preview(file), /ELOOP|changed while preparing/);
  });

  test(`preview rejects a regular-file replacement for ${extension}`, async t => {
    const { project, options } = await fixture(t);
    const file = path.join(project, `note${extension}`);
    await writeFile(file, 'safe');
    const files = replacingAccess(options, async () => {
      await rename(file, `${file}.original`);
      await writeFile(file, 'replacement');
    });
    await assert.rejects(files.preview(file), /changed while preparing/);
  });
}

test('preview rejects a parent-directory symlink replacement', async t => {
  const { project, outside, options } = await fixture(t);
  const directory = path.join(project, 'docs');
  await mkdir(directory);
  await writeFile(path.join(directory, 'note.txt'), 'safe');
  await writeFile(path.join(outside, 'note.txt'), 'private');
  const files = replacingAccess(options, async () => {
    await rename(directory, `${directory}.original`);
    await symlink(outside, directory, 'junction');
  });
  await assert.rejects(files.preview(path.join(directory, 'note.txt')), /changed while preparing/);
});

test('preview reads the validated handle even if its pathname is replaced before read', async t => {
  const { project, outside, options } = await fixture(t);
  const file = path.join(project, 'note.txt');
  const secret = path.join(outside, 'secret.txt');
  await writeFile(file, 'safe');
  await writeFile(secret, 'private');
  const probe = await open(file);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = prototype.read;
  let handle;
  t.mock.method(prototype, 'read', async function (...args) {
    handle = this;
    await rename(file, `${file}.original`);
    await symlink(secret, file);
    return read.apply(this, args);
  });
  assert.equal((await new FileAccess(options).preview(file)).text, 'safe');
  assert.equal(handle.fd, -1);
});

test('preview fails closed without a usable opened-file identity and closes the handle', async t => {
  const { project, options } = await fixture(t);
  const file = path.join(project, 'note.txt');
  await writeFile(file, 'safe');
  const probe = await open(file);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const stat = prototype.stat;
  let handle;
  t.mock.method(prototype, 'stat', async function (...args) {
    handle = this;
    const info = await stat.apply(this, args);
    info.ino = 0n;
    return info;
  });
  const read = t.mock.method(prototype, 'read', () => { throw new Error('must not read'); });
  await assert.rejects(new FileAccess(options).preview(file), /changed while preparing/);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(handle.fd, -1);
});

test('previews retain bounded text, image, binary, and document behavior', async t => {
  const { project, options } = await fixture(t);
  const files = new FileAccess(options);
  await writeFile(path.join(project, 'note.md'), 'x'.repeat(512 * 1024 + 10));
  const text = await files.preview('note.md', project);
  assert.equal(text.text.length, 512 * 1024);
  assert.equal(text.truncated, true);
  assert.equal(text.size, 512 * 1024 + 10);
  assert.equal(text.mimeType, 'text/markdown');
  await writeFile(path.join(project, 'pixel.png'), 'image');
  assert.equal((await files.preview('pixel.png', project)).data, Buffer.from('image').toString('base64'));
  await writeFile(path.join(project, 'binary.bin'), Buffer.from([0, 1, 2]));
  assert.equal((await files.preview('binary.bin', project)).kind, 'other');
  await writeFile(path.join(project, 'note.pdf'), 'pdf');
  assert.equal((await files.preview('note.pdf', project)).mimeType, 'application/pdf');
});

test('mock Windows rejects executable associations case-insensitively without opening them', async t => {
  const { project, opened, options } = await fixture(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  try {
    const { FileAccess: WindowsFileAccess } = await import('../../electron/file-access.mjs?windows-associations');
    const files = new WindowsFileAccess(options);
    const dangerous = ['.py', '.pyw', '.pyc', '.pyo', '.pyz', '.pyzw', '.rb', '.rbw', '.pl', '.plx', '.pm', '.tcl', '.lua', '.php', '.pif', '.js', '.jse', '.exe', '.com', '.bat', '.cmd', '.msi', '.msix', '.ps1', '.psm1', '.vbs', '.vbe', '.wsf', '.wsh', '.scr', '.lnk', '.reg', '.hta', '.cpl', '.url', '.jar', '.wsc', '.sct', '.application', '.appref-ms', '.gadget', '.library-ms', '.search-ms', '.settingcontent-ms', '.inf', '.ins', '.isp', '.ps1xml', '.ps2', '.ps2xml', '.psc1', '.psc2', '.msh', '.msh1', '.msh2', '.mshxml', '.msh1xml', '.msh2xml', '.ws', '.vb', '.vba', '.vbp', '.mst', '.msp'];
    for (const extension of dangerous) {
      for (const spelling of [extension, extension.toUpperCase()]) {
        const file = path.join(project, `danger${spelling}`);
        await writeFile(file, 'inert test data');
        assert.equal((await files.preview(file)).canOpen, false, spelling);
        await assert.rejects(files.open(file), /does not open apps or scripts/, spelling);
      }
    }
    assert.deepEqual(opened, []);
    for (const extension of ['.txt', '.md', '.pdf', '.png', '.docx', '.xlsx', '.csv', '.json', '.ts', '.html']) {
      const file = path.join(project, `ordinary${extension.toUpperCase()}`);
      await writeFile(file, 'inert document');
      assert.equal((await files.preview(file)).canOpen, true, extension);
      await files.open(file);
    }
    assert.equal(opened.length, 10);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

test('mock Windows rejects symlink replacements using opened-file identity without O_NOFOLLOW', async t => {
  const { project, outside, options } = await fixture(t);
  const file = path.join(project, 'note.txt');
  const secret = path.join(outside, 'secret.txt');
  await writeFile(file, 'safe');
  await writeFile(secret, 'private');
  const files = replacingAccess(options, async () => {
    await rename(file, `${file}.original`);
    await symlink(secret, file);
  });
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
  try {
    await assert.rejects(files.preview(file), /changed while preparing/);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});
