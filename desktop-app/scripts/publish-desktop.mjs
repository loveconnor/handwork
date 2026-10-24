import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mergeReleaseManifests, releaseRepository, releaseTag, sha256 } from './desktop-release-artifacts.mjs';

const version = process.env.DESKTOP_VERSION;
const tag = releaseTag(version);
const commit = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Missing release commit');
const directory = path.resolve(process.argv[2] || 'release-assets');
const names = await readdir(directory);
const parts = await Promise.all(names.filter(name => /^(darwin|windows)-.*\.json$/.test(name)).map(async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
const manifest = mergeReleaseManifests(parts, version);
for (const part of parts) {
  if (await sha256(path.join(directory, part.file)) !== part.sha256) throw new Error(`Artifact checksum mismatch: ${part.file}`);
  if ((await readFile(path.join(directory, `${part.file}.sig`), 'utf8')).trim() !== part.signature.trim()) throw new Error(`Artifact signature mismatch: ${part.file}`);
}
if (!names.some(name => name.endsWith('.dmg'))) throw new Error('Missing Mac installer');
const gh = args => execFileSync('gh', [...args, '--repo', releaseRepository], { stdio: 'inherit' });
const exists = name => {
  try { execFileSync('gh', ['release', 'view', name, '--repo', releaseRepository], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const previous = await fetch(`https://github.com/${releaseRepository}/releases/download/desktop-stable/latest.json`);
if (previous.ok) {
  const old = (await previous.json()).version;
  releaseTag(old);
  const older = old.split('.').map(Number);
  const difference = version.split('.').map((value, index) => Number(value) - older[index]).find(value => value !== 0) || 0;
  if (difference <= 0) throw new Error(`Refusing to replace desktop ${old} with ${version}`);
} else if (previous.status !== 404) throw new Error('Could not verify the current update channel');
if (exists(tag)) throw new Error(`Desktop ${version} already exists. Push a new commit for a new version.`);
await writeFile(path.join(directory, 'latest.json'), JSON.stringify(manifest, null, 2));
gh(['release', 'create', tag, '--draft', '--target', commit, '--title', `Handwork Desktop ${version}`, '--notes', `Tauri desktop build from ${commit}, with its bundled Handwork engine. Download the .dmg for Apple Silicon Mac or the windows .exe for your PC architecture.`]);
gh(['release', 'upload', tag, ...names.filter(name => /\.(exe|dmg|tar\.gz|sig)$/.test(name)).map(name => path.join(directory, name)), path.join(directory, 'latest.json')]);
gh(['release', 'edit', tag, '--draft=false', '--latest=false']);
if (!exists('desktop-stable')) gh(['release', 'create', 'desktop-stable', '--target', commit, '--prerelease', '--latest=false', '--title', 'Handwork Desktop update channel', '--notes', 'Stable desktop update metadata. Installers live in the versioned Desktop releases.']);
// Promote only after every platform is available at its immutable URL.
gh(['release', 'upload', 'desktop-stable', '--clobber', path.join(directory, 'latest.json')]);
