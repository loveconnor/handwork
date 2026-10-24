import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const releaseRepository = 'loveconnor/handwork';
export const releaseTargets = {
  'aarch64-apple-darwin': { platform: 'darwin-aarch64', extension: '.app.tar.gz' },
  'x86_64-pc-windows-msvc': { platform: 'windows-x86_64', extension: '.exe' },
  'aarch64-pc-windows-msvc': { platform: 'windows-aarch64', extension: '.exe' },
};
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function releaseTag(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('A stable DESKTOP_VERSION is required');
  return `desktop-v${version}`;
}
export function mergeReleaseManifests(parts, version) {
  const tag = releaseTag(version);
  const platforms = {};
  for (const part of parts) {
    if (part.version !== version || !releaseTargets[part.target]) throw new Error('Release version or target mismatch');
    const { platform, extension } = releaseTargets[part.target];
    if (platforms[platform]) throw new Error(`Duplicate release target: ${platform}`);
    if (!part.file || part.file.includes('/') || part.file.includes('\\') || !part.file.endsWith(extension) || !part.signature?.trim() || !/^[a-f0-9]{64}$/.test(part.sha256 || '')) throw new Error(`Invalid artifact for ${platform}`);
    platforms[platform] = {
      signature: part.signature.trim(),
      url: `https://github.com/${releaseRepository}/releases/download/${tag}/${encodeURIComponent(part.file)}`,
    };
  }
  for (const { platform } of Object.values(releaseTargets)) {
    if (!platforms[platform]) throw new Error(`Missing release target: ${platform}`);
  }
  return { version, notes: `Handwork ${version}`, pub_date: new Date().toISOString(), platforms };
}
