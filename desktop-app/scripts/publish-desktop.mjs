import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
const repo = 'loveconnor/handwork';
const version = process.env.DESKTOP_VERSION;
const commit = process.env.GITHUB_SHA;
if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Missing release version or commit');
const directory = path.resolve(process.argv[2] || 'release-assets');
const names = await readdir(directory);
const tag = `desktop-v${version}`;
const gh = args => execFileSync('gh', [...args, '--repo', repo], { stdio: 'inherit' });
const exists = tag => {
  try { execFileSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' }); return true; }
  catch { return false; }
};
const metadata = names.filter(name => /^latest(?:-x64|-arm64|-mac)?\.yml$/.test(name));
for (const name of ['latest-x64.yml', 'latest-arm64.yml']) if (!metadata.includes(name)) throw new Error(`Missing ${name}`);
for (const name of metadata) {
  const file = path.join(directory, name);
  const info = yaml.load(await readFile(file, 'utf8'));
  if (info.version !== version || !Array.isArray(info.files) || !info.files.length) throw new Error(`Invalid update manifest: ${name}`);
  const absolute = artifact => {
    const basename = path.basename(artifact);
    if (!names.includes(basename)) throw new Error(`Manifest references a missing artifact: ${basename}`);
    return `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(basename)}`;
  };
  for (const entry of info.files) {
    const artifact = path.join(directory, path.basename(entry.url));
    const digest = createHash('sha512');
    for await (const chunk of createReadStream(artifact)) digest.update(chunk);
    if (digest.digest('base64') !== entry.sha512) throw new Error(`Installer checksum does not match ${name}`);
    entry.url = absolute(entry.url);
  }
  if (info.path) info.path = absolute(info.path);
  await writeFile(file, yaml.dump(info));
}
const previousResponse = await fetch(`https://github.com/${repo}/releases/download/desktop-stable/latest-x64.yml`);
if (previousResponse.ok) {
  const previous = yaml.load(await previousResponse.text()).version;
  if (!/^\d+\.\d+\.\d+$/.test(previous)) throw new Error('Invalid existing desktop channel version');
  const older = previous.split('.').map(Number);
  const newer = version.split('.').map(Number);
  const difference = newer.map((value, index) => value - older[index]).find(value => value !== 0) || 0;
  if (difference <= 0) throw new Error(`Refusing to replace desktop ${previous} with ${version}. Push a newer base version.`);
} else if (previousResponse.status !== 404) throw new Error('Could not verify the current desktop channel version');
// Never replace bytes for an already published version. A rerun must not change
// the artifact underneath clients which already downloaded that version.
if (exists(tag)) throw new Error(`Desktop release ${version} already exists. Push a new commit for a new version.`);
gh(['release', 'create', tag, '--draft', '--target', commit, '--title', `Handwork Desktop ${version}`, '--notes', `Desktop build from ${commit}. Includes its native Handwork engine.`]);
gh(['release', 'upload', tag, ...names.filter(name => /\.(exe|dmg|zip|yml|blockmap)$/.test(name)).map(name => path.join(directory, name))]);
gh(['release', 'edit', tag, '--draft=false', '--latest=false']);
if (!exists('desktop-stable')) gh(['release', 'create', 'desktop-stable', '--target', commit, '--prerelease', '--latest=false', '--title', 'Handwork Desktop update channel', '--notes', 'Stable desktop update metadata. Installers live in the versioned Desktop releases.']);
// Promote metadata only after all immutable artifacts have been published.
gh(['release', 'upload', 'desktop-stable', '--clobber', ...metadata.map(name => path.join(directory, name))]);
