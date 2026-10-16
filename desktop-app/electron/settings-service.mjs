import path from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rename, readdir, lstat, unlink, rmdir } from 'node:fs/promises';
import { DesktopSettings } from './desktop-settings.mjs';
import { readInstructions, saveInstructions, enginePreferences, attachmentUsage } from './settings-files.mjs';

const exec = promisify(execFile);
export class SettingsService {
  constructor({ settings = new DesktopSettings(), home = homedir(), host = {}, version = '0.1.0' } = {}) { this.settings = settings; this.home = home; this.host = host; this.version = version; }
  snapshot(workspace) { return this.settings.snapshot(workspace); }
  async info(binary, workspace, attachmentDirectory, extraAttachmentDirectories = []) {
    let engineVersion = 'Unavailable';
    try { engineVersion = (await exec(binary, ['--version'], { timeout: 3000, maxBuffer: 4096 })).stdout.trim().slice(0, 160); } catch { /* Report the unavailable engine accurately. */ }
    const attachments = await attachmentUsage(attachmentDirectory);
    for (const directory of extraAttachmentDirectories) {
      const usage = await attachmentUsage(directory);
      attachments.count += usage.count;
      attachments.bytes += usage.bytes;
    }
    const preferences = await enginePreferences(this.home, workspace);
    return { appVersion: this.version, engineVersion, platform: process.platform, architecture: process.arch, attachments, historyPath: path.join(this.home, '.handwork', 'sessions'), enginePreferences: preferences, updatesConfigured: !!this.host.checkUpdates };
  }
  instructions(workspace, scope) { return readInstructions(this.home, workspace, scope); }
  saveInstructions(workspace, scope, text, revision) { return saveInstructions(this.home, workspace, scope, text, revision); }
  async openTarget(workspace, target, attachmentDirectory) {
    const known = { history: path.join(this.home, '.handwork', 'sessions'), attachments: attachmentDirectory, engineSettings: path.join(this.home, '.handwork', 'settings.json'), appInstructions: path.join(this.home, '.handwork', 'AGENTS.md'), projectInstructions: workspace ? path.join(workspace, 'AGENTS.md') : null };
    if (target === 'help') return this.host.openHelp?.();
    if (target === 'releases') return this.host.openReleases?.();
    const file = known[target];
    if (!file) throw new Error('This location is unavailable');
    if (target === 'history' || target === 'attachments') await mkdir(file, { recursive: true, mode: 0o700 });
    else { try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') throw new Error('Save this file in Settings before opening it in an editor.'); throw error; } }
    if (!this.host.openFile) throw new Error('Opening files is unavailable in this preview');
    return this.host.openFile(file, target === 'history' || target === 'attachments' ? 'system' : this.settings.snapshot(workspace).app.preferredEditor);
  }
  async clearSuggestions(backend) { backend.cancelSuggestions(); backend.suggestionCache.clear(); return { cleared: true }; }
  async clearAttachments(directory) {
    const root = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (root && !root.isDirectory()) throw new Error('The attachment folder contains unexpected items. Inspect the folder before clearing it.');
    // Move snapshots aside first. A failed rename leaves the original directory intact.
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (entries.some(entry => !entry.isFile())) throw new Error('The attachment folder contains unexpected items. Inspect the folder before clearing it.');
    const archive = directory + '.removing-' + Date.now();
    try { await rename(directory, archive); } catch (error) { if (error.code === 'ENOENT') return { removed: 0 }; throw error; }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let removed = 0;
    for (const name of await readdir(archive)) {
      const file = path.join(archive, name);
      if ((await lstat(file)).isFile()) { await unlink(file); removed++; }
    }
    await rmdir(archive);
    return { removed };
  }
  async diagnostics(binary, workspace, directory, extraAttachmentDirectories = []) {
    const info = await this.info(binary, workspace, directory, extraAttachmentDirectories);
    const effective = this.snapshot(workspace).effective;
    return JSON.stringify({ application: 'Handwork', appVersion: info.appVersion, engineVersion: info.engineVersion, platform: info.platform, architecture: info.architecture, provider: effective.defaultProvider || 'Engine default', mode: effective.defaultMode, savedAttachmentCount: info.attachments.count, savedAttachmentBytes: info.attachments.bytes }, null, 2);
  }
}
