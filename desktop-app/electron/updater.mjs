import { EventEmitter } from 'node:events';

const CHECK_INTERVAL = 60 * 60 * 1000;

/** The renderer gets status and three actions, never an installer path or feed URL. */
export class DesktopUpdater extends EventEmitter {
  constructor({ updater, available, unavailableReason, isBusy = () => false, beforeInstall = async () => {} }) {
    super();
    this.updater = updater;
    this.isBusy = isBusy;
    this.beforeInstall = beforeInstall;
    this.state = { status: available ? 'idle' : 'unavailable', message: available ? 'Check for updates.' : unavailableReason || 'Install a release build to enable updates.' };
    if (!available) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableDifferentialDownload = true;
    updater.on('checking-for-update', () => this.set({ status: 'checking', version: undefined, progress: undefined, message: 'Checking for updates…' }));
    updater.on('update-available', info => this.set({ status: 'available', version: info.version, message: `Handwork ${info.version} is available.` }));
    updater.on('update-not-available', () => this.set({ status: 'idle', version: undefined, message: 'You’re up to date.' }));
    updater.on('download-progress', progress => this.set({ status: 'downloading', progress: Math.max(0, Math.min(100, Math.round(progress.percent || 0))), message: 'Downloading the update. You can keep working.' }));
    updater.on('update-downloaded', info => this.set({ status: 'downloaded', version: info.version, progress: 100, message: 'Update ready. Restart when you’re ready.' }));
    updater.on('error', () => this.fail());
  }
  snapshot() { return { ...this.state }; }
  set(patch) { this.state = { ...this.state, ...patch }; this.emit('state', this.snapshot()); return this.snapshot(); }
  fail() {
    return this.set({ status: 'error', message: this.state.version ? 'The update could not finish. Try downloading again.' : 'Couldn’t check for updates. Check your connection and try again.' });
  }
  async check() {
    if (this.state.status === 'unavailable' || ['downloading', 'downloaded', 'installing'].includes(this.state.status)) return this.snapshot();
    if (this.pending) return this.pending;
    this.nextCheckAt = Date.now() + CHECK_INTERVAL;
    this.set({ status: 'checking', version: undefined, progress: undefined, message: 'Checking for updates…' });
    this.pending = Promise.resolve().then(async () => {
      try { await this.updater.checkForUpdates(); }
      catch { this.fail(); }
      finally { this.pending = null; }
      return this.snapshot();
    });
    return this.pending;
  }
  async download() {
    if (this.pending) return this.pending;
    if (!this.state.version || !['available', 'error'].includes(this.state.status)) throw new Error('Check for an update before downloading.');
    this.set({ status: 'downloading', progress: 0, message: 'Downloading the update. You can keep working.' });
    this.pending = Promise.resolve().then(async () => {
      try { await this.updater.downloadUpdate(); }
      catch { this.fail(); }
      finally { this.pending = null; }
      return this.snapshot();
    });
    return this.pending;
  }
  async install(drafts) {
    if (this.state.status !== 'downloaded') throw new Error('Download the update before restarting.');
    if (this.isBusy()) throw new Error('Finish or stop the current response before restarting.');
    this.set({ status: 'installing', message: 'Saving drafts and restarting…' });
    try {
      await this.beforeInstall(drafts);
      this.updater.quitAndInstall(true, true);
    } catch (error) {
      this.set({ status: 'downloaded', message: error.message || 'Couldn’t restart. Try again.' });
      throw error;
    }
    return this.snapshot();
  }
  start() {
    if (this.state.status === 'unavailable' || this.initial || this.interval) return;
    this.nextCheckAt = Date.now() + 15000;
    this.initial = setTimeout(() => {
      void this.checkIfDue();
      this.interval = setInterval(() => void this.checkIfDue(), CHECK_INTERVAL);
      this.interval.unref?.();
    }, 15000);
    this.initial.unref?.();
  }
  async checkIfDue() {
    // Keep an available update visible until the user chooses to download it.
    // Focus and wake events share the timer's throttle, including manual checks.
    if ((!this.initial && !this.interval) || Date.now() < this.nextCheckAt || this.state.version) return this.snapshot();
    return this.check();
  }
  stop() { clearTimeout(this.initial); clearInterval(this.interval); this.initial = null; this.interval = null; }
}
