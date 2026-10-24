import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { releaseTag, releaseTargets, sha256 } from './desktop-release-artifacts.mjs';

const version = process.env.DESKTOP_VERSION;
releaseTag(version);
const target = process.env.DESKTOP_TARGET;
const spec = releaseTargets[target];
if (!spec) throw new Error('Unsupported DESKTOP_TARGET');
const root = path.resolve('target', target, 'release', 'bundle');
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() && !entry.name.endsWith('.app') ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}
const files = await walk(root);
const packages = files.filter(file => file.endsWith(spec.extension));
if (packages.length !== 1) throw new Error(`Expected one ${spec.extension} updater package, got ${packages.length}`);
const updater = packages[0];
const signature = (await readFile(`${updater}.sig`, 'utf8')).trim();
if (!signature) throw new Error('Missing updater signature');
const output = path.resolve('release-assets');
await mkdir(output, { recursive: true });
// macOS updater archives otherwise have the same name for every architecture.
const filename = `Handwork-${version}-${spec.platform}${spec.extension}`;
await copyFile(updater, path.join(output, filename));
await copyFile(`${updater}.sig`, path.join(output, `${filename}.sig`));
if (spec.platform.startsWith('darwin')) {
  const dmgs = files.filter(file => file.endsWith('.dmg'));
  if (dmgs.length !== 1) throw new Error('Expected one macOS DMG');
  await copyFile(dmgs[0], path.join(output, `Handwork-${version}-${spec.platform}.dmg`));
}
await writeFile(path.join(output, `${spec.platform}.json`), JSON.stringify({ version, target, file: filename, signature, sha256: await sha256(updater) }, null, 2));
