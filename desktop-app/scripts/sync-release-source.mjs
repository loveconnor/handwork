import { execFileSync } from 'node:child_process';
import { access, copyFile, chmod, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.resolve(process.argv[2] || path.join(root, '../handwork'));
await access(path.join(engine, 'build.zig'));
const git = args => execFileSync('git', args, { cwd: engine, encoding: 'utf8' }).trim();
if (git(['status', '--porcelain'])) throw new Error('The engine checkout has uncommitted changes. Commit or stash them before syncing.');
const remote = git(['remote', 'get-url', 'origin']);
if (!/^https:\/\/github\.com\/loveconnor\/handwork(?:\.git)?$|^git@github\.com:loveconnor\/handwork(?:\.git)?$/.test(remote)) {
  throw new Error('The release checkout must point to loveconnor/handwork.');
}
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(file => file && !file.startsWith('.github/'));
for (const file of files) {
  const source = path.join(root, file);
  const destination = path.join(engine, 'desktop-app', file);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, (await stat(source)).mode);
}
console.log(`Synced ${files.length} tracked source files to ${engine}/desktop-app. Review and commit the changes, then push to start the signed release pipeline.`);
