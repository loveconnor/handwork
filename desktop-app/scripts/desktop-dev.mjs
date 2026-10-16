import { createServer } from 'vite';
import { desktopRuntime } from './desktop-runtime.mjs';
import { enginePath } from '../electron/engine-path.mjs';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = enginePath({ root, packaged: false });
await access(binary, constants.X_OK);
const electron = await desktopRuntime();
const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { host: '127.0.0.1', port: 5173, strictPort: true } });
let child;
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2500);
    await exited;
    clearTimeout(timer);
  }
  await server.close();
  process.exitCode = code;
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
try {
  await server.listen();
  const env = { ...process.env, HANDWORK_BINARY: binary };
  delete env.ELECTRON_RUN_AS_NODE;
  if (stopping) {
    await server.close();
  } else {
    child = spawn(electron, [path.join(root, 'electron/main.mjs')], { cwd: root, env, stdio: 'inherit', shell: false });
    child.once('error', (error) => { console.error(error); void stop(1); });
    child.once('exit', (code, signal) => { void stop(signal ? 1 : code ?? 1); });
  }
} catch (error) {
  console.error(error);
  await stop(1);
}
