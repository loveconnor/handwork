import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export const settingDefaults = Object.freeze({ theme: 'system', uiFontSize: 14, codeFontSize: 13, sendKey: 'enter', restoreChats: true, preferredEditor: 'system', defaultProvider: '', defaultModel: '', defaultMode: 'code', suggestions: true, notifyComplete: false, notifyApproval: false, notifyError: true, notificationSound: false, notificationsBackgroundOnly: true, keepRunning: false, quickEntryShortcut: process.platform === 'darwin' ? 'Alt+Space' : 'Control+Alt+Space' });
const choices = { theme: ['system', 'light', 'dark'], sendKey: ['enter', 'modifier-enter'], preferredEditor: ['system', 'vscode', 'cursor', 'zed'], defaultMode: ['ask', 'code'], quickEntryShortcut: ['off', 'Alt+Space', 'Control+Alt+Space', 'CommandOrControl+Shift+Space'] };
const projectKeys = ['defaultProvider', 'defaultModel', 'defaultMode', 'suggestions'];
export function validSettingsPatch(scope, value) {
  if (!['app', 'project'].includes(scope) || !value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) return false;
  return Object.entries(value).every(([key, item]) => {
    if (!Object.hasOwn(settingDefaults, key) || (scope === 'project' && !projectKeys.includes(key))) return false;
    if (choices[key]) return choices[key].includes(item);
    if (key === 'uiFontSize' || key === 'codeFontSize') return Number.isInteger(item) && item >= 11 && item <= 20;
    if (key === 'defaultProvider' || key === 'defaultModel') return typeof item === 'string' && item.length <= 200 && !/[\x00-\x1f]/.test(item);
    return typeof item === 'boolean';
  });
}
export class DesktopSettings {
  constructor(file) { this.file = file; this.memory = { app: {}, projects: {}, startup: { tabs: [], active: '' } }; }
  read() {
    if (!this.file || !existsSync(this.file)) return structuredClone(this.memory);
    const data = JSON.parse(readFileSync(this.file, 'utf8'));
    if (data?.version !== 1 || !data.app || !data.projects || typeof data.projects !== 'object') throw new Error('Desktop settings could not be read. Keep the file for recovery.');
    if ((Object.keys(data.app).length && !validSettingsPatch('app', data.app)) || Object.values(data.projects).some(value => !value || typeof value !== 'object' || (Object.keys(value).length && !validSettingsPatch('project', value)))) throw new Error('Desktop settings contain invalid preferences. Keep the file for recovery.');
    return data;
  }
  write(data) {
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.tmp';
      writeFileSync(temporary, JSON.stringify({ ...data, version: 1 }, null, 2), { mode: 0o600 });
      renameSync(temporary, this.file);
    }
    this.memory = data;
  }
  snapshot(workspace = '') {
    const data = this.read();
    const app = { ...settingDefaults, ...data.app };
    const project = workspace && Object.hasOwn(data.projects, workspace) ? data.projects[workspace] : {};
    return { app, project, effective: { ...app, ...project }, workspace, initialized: !!this.file && existsSync(this.file) };
  }
  update(scope, patch, workspace = '') {
    if (!validSettingsPatch(scope, patch) || (scope === 'project' && !workspace)) throw new Error('Invalid desktop setting');
    const data = this.read();
    if (scope === 'app') data.app = { ...data.app, ...patch };
    else data.projects = { ...data.projects, [workspace]: { ...(Object.hasOwn(data.projects, workspace) ? data.projects[workspace] : {}), ...patch } };
    this.write(data);
    return this.snapshot(workspace);
  }
  /** Applies preferences from a backup. Invalid values are ignored; startup tabs stay local. */
  importPreferences({ app, projects }) {
    const data = this.read();
    const valid = (scope, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key, item]) => validSettingsPatch(scope, { [key]: item }))) : {};
    const incoming = valid('app', app);
    const overrides = projects && typeof projects === 'object' && !Array.isArray(projects)
      ? Object.fromEntries(Object.entries(projects).filter(([workspace]) => path.isAbsolute(workspace) && !workspace.includes('\0')).map(([workspace, value]) => [workspace, valid('project', value)]).filter(([, value]) => Object.keys(value).length))
      : {};
    if (!Object.keys(incoming).length && !Object.keys(overrides).length) return false;
    data.app = { ...data.app, ...incoming };
    data.projects = { ...data.projects, ...Object.fromEntries(Object.entries(overrides).map(([workspace, value]) => [workspace, { ...(Object.hasOwn(data.projects, workspace) ? data.projects[workspace] : {}), ...value }])) };
    this.write(data);
    return true;
  }
  resetProject(workspace) { const data = this.read(); delete data.projects[workspace]; this.write(data); return this.snapshot(workspace); }
  saveStartup(startup) { const data = this.read(); data.startup = startup; this.write(data); }
  startup() { return this.read().startup ?? { tabs: [], active: '' }; }
}
