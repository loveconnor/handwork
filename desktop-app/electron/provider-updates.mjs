import { execFile as execFileCallback } from 'node:child_process';
import { access, constants, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const VERSION_TIMEOUT_MS = 10_000;
const FEED_TIMEOUT_MS = 10_000;
// A download plus, for npm installs, a full dependency install.
const UPDATE_TIMEOUT_MS = 300_000;

/**
 * Local software behind a provider, as the native app tracked its agent CLIs.
 * `npm` names the release feed and the package an npm install is repaired from;
 * `update` is the tool's own updater for a native install; a `download` page
 * stands in where the app updates itself and has no command to run.
 */
export const PROVIDER_SOFTWARE = {
  codex: { name: 'Codex CLI', binary: 'codex', npm: '@openai/codex', update: ['update'] },
  opencode: { name: 'OpenCode', binary: 'opencode', npm: 'opencode-ai', update: ['upgrade'] },
  ollama: { name: 'Ollama', binary: 'ollama', github: 'ollama/ollama', download: 'https://ollama.com/download' },
};

/** "codex-cli 0.165.0", "ollama version is 0.40.10", "v1.2.3-beta" → "0.165.0"… */
export function parseVersion(text) {
  return /(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''))?.[0] ?? null;
}

export function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

/**
 * Checks each connected provider's local software against its public release
 * feed, once per launch, and runs its updater on request. A failed lookup,
 * offline or otherwise, drops that provider silently: the check runs unasked
 * and must never raise an error of its own.
 */
export class ProviderUpdates {
  constructor({ env = process.env, execFile = execFileCallback, fetch = globalThis.fetch, openExternal = async () => {}, directories = searchDirectories(env) } = {}) {
    this.env = env; this.execFileImpl = execFile; this.fetch = fetch; this.openExternal = openExternal; this.directories = directories;
    this.launchCheck = null;
  }

  /** Every caller in this run shares one check; the next launch checks again. */
  check(providers) {
    this.launchCheck ??= this.find(providers.filter(id => Object.hasOwn(PROVIDER_SOFTWARE, id)));
    return this.launchCheck;
  }

  async find(providers) {
    const results = await Promise.all(providers.map(id => this.inspect(id).catch(() => null)));
    return results.filter(Boolean);
  }

  async inspect(provider) {
    const software = PROVIDER_SOFTWARE[provider];
    const binary = await this.locate(software.binary);
    if (!binary) return null;
    const [installed, latest, prefix] = await Promise.all([this.installedVersion(binary), this.latestVersion(software), this.npmPrefix(software, binary)]);
    if (!latest) return null;
    const base = { provider, name: software.name, latest, action: software.download ? 'download' : 'update' };
    // An npm install that cannot report its version is damaged, and reinstalling
    // the package is the fix its own error asks for.
    if (!installed) return prefix ? { ...base, installed: null, action: 'reinstall' } : null;
    return compareVersions(latest, installed) > 0 ? { ...base, installed } : null;
  }

  async update(provider) {
    const software = PROVIDER_SOFTWARE[provider];
    if (software.download) {
      await this.openExternal(software.download);
      return { opened: true };
    }
    const binary = await this.locate(software.binary);
    if (!binary) throw new Error(`${software.name} is no longer installed.`);
    const prefix = await this.npmPrefix(software, binary);
    if (prefix) {
      const npm = await this.locate('npm');
      if (!npm) throw new Error(`npm is required to update ${software.name}. Install Node.js and try again.`);
      await this.run(npm, ['install', '--global', '--prefix', prefix, `${software.npm}@latest`, '--no-audit', '--no-fund'], UPDATE_TIMEOUT_MS);
    } else {
      await this.run(binary, software.update, UPDATE_TIMEOUT_MS);
    }
    // Some updaters exit cleanly without installing anything, so success is the
    // version the tool reports afterwards, not the exit code.
    const [version, latest] = await Promise.all([this.installedVersion(binary), this.latestVersion(software)]);
    if (version && (!latest || compareVersions(version, latest) >= 0)) {
      this.launchCheck = null;
      return { version };
    }
    throw new Error(`${software.name} is still ${version ?? 'not working'} at ${binary}. Update that installation from a terminal.`);
  }

  async locate(name) {
    for (const directory of this.directories) {
      const candidate = path.join(directory, process.platform === 'win32' ? `${name}.cmd` : name);
      try { await access(candidate, constants.X_OK); return candidate; } catch { /* Try the next directory. */ }
    }
    return null;
  }

  async installedVersion(binary) {
    try { return parseVersion(await this.run(binary, ['--version'], VERSION_TIMEOUT_MS)); } catch { return null; }
  }

  async latestVersion(software) {
    const signal = AbortSignal.timeout(FEED_TIMEOUT_MS);
    const headers = { 'user-agent': 'Handwork', accept: 'application/json' };
    if (software.npm) {
      const response = await this.fetch(`https://registry.npmjs.org/${software.npm.replace('/', '%2F')}/latest`, { signal, headers });
      return response.ok ? parseVersion((await response.json()).version) : null;
    }
    const response = await this.fetch(`https://api.github.com/repos/${software.github}/releases/latest`, { signal, headers });
    return response.ok ? parseVersion((await response.json()).tag_name) : null;
  }

  /** The prefix an npm-installed package lives under, so updating it never touches another install. */
  async npmPrefix(software, binary) {
    if (!software.npm) return null;
    let resolved;
    try { resolved = await realpath(binary); } catch { return null; }
    for (let directory = path.dirname(resolved); directory !== path.dirname(directory); directory = path.dirname(directory)) {
      try {
        if (JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).name !== software.npm) continue;
      } catch { continue; }
      const modules = directory.split(path.sep).lastIndexOf('node_modules');
      if (modules < 0) return null;
      const parent = directory.split(path.sep).slice(0, modules).join(path.sep) || path.sep;
      return path.basename(parent) === 'lib' ? path.dirname(parent) : parent;
    }
    return null;
  }

  run(command, args, timeout) {
    return new Promise((resolve, reject) => {
      this.execFileImpl(command, args, { env: { ...this.env, PATH: [...this.directories, this.env.PATH].filter(Boolean).join(path.delimiter) }, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(lastLine(stderr) || lastLine(stdout) || error.message));
        else resolve(`${stdout}\n${stderr}`);
      });
    });
  }
}

function lastLine(text) {
  return String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? '';
}

/** PATH plus where installers put tools; apps opened from the Dock lack the shell's PATH. */
export function searchDirectories(env = process.env) {
  const home = env.HOME || homedir();
  const listed = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const common = process.platform === 'win32' ? [] : [path.join(home, '.vite-plus/bin'), path.join(home, '.opencode/bin'), path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  return [...new Set([...listed, ...common])];
}
