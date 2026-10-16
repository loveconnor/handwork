import './build-genui-prompt.mjs';
import { build } from 'vite';
import { desktopTarget, stageEngine } from './desktop-engine.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildDesktop(target = desktopTarget()) {
  const destination = await stageEngine(root, target);
  await build({ configFile: path.join(root, 'vite.config.ts') });
  console.log(`Desktop renderer built; ${target.platform}-${target.arch} engine staged in ${destination}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDesktop(desktopTarget(process.argv[2] || process.platform, process.argv[3] || process.arch));
}
