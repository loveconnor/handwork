'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { resolveBinary } = require('../../bin/handwork.cjs');

function executable(machine) {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(128, 0x3c);
  bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(machine, 132);
  return bytes;
}

test('npm launcher selects each Windows architecture and rejects the wrong binary', () => {
  const root = mkdtempSync(join(tmpdir(), 'handwork npm 日本語 '));
  try {
    for (const [arch, machine] of [['x64', 0x8664], ['arm64', 0xaa64]]) {
      const directory = join(root, 'prebuilds', `win32-${arch}`, 'bin');
      mkdirSync(directory, { recursive: true });
      const binary = join(directory, 'handwork.exe');
      writeFileSync(binary, executable(machine));
      assert.equal(resolveBinary(root, 'win32', arch), binary);
    }
    writeFileSync(join(root, 'prebuilds', 'win32-x64', 'bin', 'handwork.exe'), executable(0xaa64));
    assert.throws(() => resolveBinary(root, 'win32', 'x64'), /wrong architecture/);
    assert.throws(() => resolveBinary(root, 'linux', 'x64'), /does not support/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('npm launcher permits a matching checkout build and reports a missing executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'handwork-npm-'));
  try {
    assert.throws(() => resolveBinary(root, 'darwin', 'arm64'), /missing/);
    const directory = join(root, 'zig-out', 'bin');
    mkdirSync(directory, { recursive: true });
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0xfeedfacf, 0);
    header.writeUInt32LE(0x0100000c, 4);
    writeFileSync(join(directory, 'handwork'), header);
    assert.equal(resolveBinary(root, 'darwin', 'arm64'), join(directory, 'handwork'));
    assert.throws(() => resolveBinary(root, 'win32', 'arm64'), /missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
