#!/usr/bin/env node
'use strict';

const { existsSync, openSync, readSync, closeSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const supported = new Set(['darwin-arm64', 'win32-x64', 'win32-arm64']);

function matchesTarget(file, platform, arch) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const header = Buffer.alloc(4096);
    const size = readSync(fd, header, 0, header.length, 0);
    if (platform === 'darwin') {
      return size >= 8 && header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === 0x0100000c;
    }
    if (size < 64 || header.readUInt16LE(0) !== 0x5a4d) return false;
    const pe = header.readUInt32LE(0x3c);
    if (pe + 6 > size || header.readUInt32LE(pe) !== 0x00004550) return false;
    return header.readUInt16LE(pe + 4) === (arch === 'arm64' ? 0xaa64 : 0x8664);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function resolveBinary(root, platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!supported.has(target)) throw new Error(`Handwork does not support ${target}.`);
  const filename = platform === 'win32' ? 'handwork.exe' : 'handwork';
  const candidates = [join(root, 'prebuilds', target, 'bin', filename), join(root, 'zig-out', 'bin', filename)];
  for (const candidate of candidates) {
    if (existsSync(candidate) && matchesTarget(candidate, platform, arch)) return candidate;
  }
  throw new Error(`The Handwork executable for ${target} is missing or has the wrong architecture. Reinstall handwork, or build this checkout with Zig 0.16.0.`);
}

if (require.main === module) {
  try {
    const binary = resolveBinary(resolve(__dirname, '..'));
    const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit', windowsHide: false });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { resolveBinary, matchesTarget };
