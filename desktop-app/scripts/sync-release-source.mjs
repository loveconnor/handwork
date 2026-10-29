import { execFileSync } from 'node:child_process';
import { access, copyFile, chmod, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.resolve(process.argv[2] || path.join(root, '../handwork'));
if (path.join(engine, 'desktop-app') === root) throw new Error('Source and release destination must be different checkouts.');
await access(path.join(engine, 'build.zig'));
const git = args => execFileSync('git', args, { cwd: engine, encoding: 'utf8' }).trim();
if (git(['status', '--porcelain'])) throw new Error('The engine checkout has uncommitted changes. Commit or stash them before syncing.');
const remote = git(['remote', 'get-url', 'origin']);
if (!/^https:\/\/github\.com\/loveconnor\/handwork(?:\.git)?$|^git@github\.com:loveconnor\/handwork(?:\.git)?$/.test(remote)) {
  throw new Error('The release checkout must point to loveconnor/handwork.');
}
const candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0');
const files = [];
for (const file of candidates) {
  if (!file || file.startsWith('.github/')) continue;
  const source = path.resolve(root, file);
  // CI checks out the release repository inside this checkout. Never sync it
  // into itself, even if Git lists individual files underneath it.
  if (source === engine || source.startsWith(engine + path.sep)) continue;
  try {
    // Git can return directories for nested repositories and submodules.
    if ((await stat(source)).isFile()) files.push(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const sourceFiles = new Set(files);
const previous = git(['ls-files', '-z', '--', 'desktop-app']).split('\0').filter(Boolean);
for (const file of previous) {
  if (!sourceFiles.has(file.slice('desktop-app/'.length))) await rm(path.join(engine, file));
}
for (const file of files) {
  const source = path.join(root, file);
  const destination = path.join(engine, 'desktop-app', file);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, (await stat(source)).mode);
}
console.log(`Synced ${files.length} tracked source files to ${engine}/desktop-app. Commit and push the changes to start the signed release pipeline.`);

const workflow = path.join(engine, '.github', 'workflows', 'desktop-release.yml');
await mkdir(path.dirname(workflow), { recursive: true });
await copyFile(path.join(root, 'scripts', 'ci', 'desktop-release.yml'), workflow);
