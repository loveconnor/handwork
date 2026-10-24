import { spawn } from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageEngine, desktopTarget } from './desktop-engine.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'dev', ...args] = process.argv.slice(2);
if (!['dev', 'build'].includes(command)) throw new Error('Expected dev or build');
const target = desktopTarget();
const engine = await stageEngine(root, target);
// Preserve the entire launcher/runtime layout; the executable resolves ../lib/handwork.
const configFile = path.join(root, 'src-tauri', '.handwork-build.json');
await writeFile(configFile, JSON.stringify({ bundle: { resources: { [engine + '/']: 'handwork-engine/' } } }));
const child = spawn(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri'),
  [command, '--config', configFile, ...args], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', async error => { await rm(configFile, { force: true }); console.error(error); process.exitCode = 1; });
child.on('exit', async code => { await rm(configFile, { force: true }); process.exitCode = code ?? 1; });
