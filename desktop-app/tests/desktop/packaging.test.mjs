import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { enginePath } from '../../electron/engine-path.mjs';
import { appVersion } from '../../electron/app-version.mjs';
import { desktopTarget, stageEngine } from '../../scripts/desktop-engine.mjs';

test('desktop version comes from the app manifest, not the Electron runtime', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(appVersion, manifest.version);
  const main = await readFile(new URL('../../electron/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /new SettingsService\(\{ settings, version: appVersion,/);
});

function executable(machine) {
  const header = Buffer.alloc(256);
  header.writeUInt16LE(0x5a4d);
  header.writeUInt32LE(128, 0x3c);
  header.writeUInt32LE(0x00004550, 128);
  header.writeUInt16LE(machine, 132);
  return header;
}

test('packaged engine paths use the bundled executable even with an override', () => {
  for (const platform of ['win32', 'darwin']) {
    const filename = platform === 'win32' ? 'handwork.exe' : 'handwork';
    assert.equal(enginePath({ packaged: true, resourcesPath: '/app/resources', platform, override: '/untrusted' }),
      path.join('/app/resources', 'handwork', 'bin', filename));
    assert.equal(enginePath({ packaged: false, root: '/source/desktop', platform, override: '' }),
      path.resolve('/source/handwork/zig-out/bin', filename));
  }
});

test('Windows bundles include matching engines and adjacent runtime assets; reject wrong architecture', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'handwork-package-'));
  try {
    const root = path.join(temporary, 'desktop');
    const prefix = path.join(temporary, 'native');
    const binary = path.join(prefix, 'bin', 'handwork.exe');
    await mkdir(path.dirname(binary), { recursive: true });
    await mkdir(path.join(prefix, 'lib', 'handwork'), { recursive: true });
    await writeFile(path.join(prefix, 'lib', 'handwork', 'cli.mjs'), 'runtime fixture');
    for (const [arch, machine] of [['x64', 0x8664], ['arm64', 0xaa64]]) {
      await writeFile(binary, executable(machine));
      const target = desktopTarget('win32', arch);
      const destination = await stageEngine(root, target, binary);
      assert.deepEqual(await readFile(path.join(destination, 'bin', 'handwork.exe')), executable(machine));
      assert.equal(await readFile(path.join(destination, 'lib', 'handwork', 'cli.mjs'), 'utf8'), 'runtime fixture');
      await writeFile(binary, executable(arch === 'x64' ? 0xaa64 : 0x8664));
      await assert.rejects(stageEngine(root, target, binary), /wrong executable format or architecture/);
    }
    await writeFile(binary, Buffer.from('not an executable'));
    await assert.rejects(stageEngine(root, desktopTarget('win32', 'x64'), binary), /wrong executable format/);
    assert.throws(() => desktopTarget('win32', 'ia32'), /Unsupported desktop target/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
