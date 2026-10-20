import { desktopDevProcess } from './desktop-dev-process.mjs';
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
const native = desktopDevProcess({
  launch: () => spawn(electron, [path.join(root, 'electron/main.mjs')], { cwd: root, env, stdio: 'inherit', shell: false }),
  onExit: (code, error) => { if (error) console.error(error); void stop(code); },
});
const env = { ...process.env, HANDWORK_BINARY: binary };
delete env.ELECTRON_RUN_AS_NODE;
const electronDirectory = path.join(root, 'electron');
server.watcher.add(electronDirectory);
server.watcher.on('all', (_event, file) => {
  if (path.resolve(file).startsWith(electronDirectory + path.sep)) native.restart();
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await native.close();
  await server.close();
  process.exitCode = code;
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
try {
  await server.listen();
  if (stopping) {
    await server.close();
  } else {
    native.start();
  }
} catch (error) {
  console.error(error);
  await stop(1);
}
