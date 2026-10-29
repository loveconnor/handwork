import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export const VOICE_SAMPLE_RATE = 16000;
export const MAX_VOICE_SECONDS = 120;
export const MAX_VOICE_BYTES = 44 + VOICE_SAMPLE_RATE * 2 * MAX_VOICE_SECONDS;

// Accept only the bounded mono PCM format produced by our recorder, never paths
// or arbitrary command arguments from the renderer.
export function validVoiceAudio(value) {
  if (!(value instanceof Uint8Array) || value.byteLength < 46 || value.byteLength > MAX_VOICE_BYTES) return false;
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.toString('ascii', 8, 16) === 'WAVEfmt ' && bytes.readUInt32LE(16) === 16 &&
    bytes.readUInt16LE(20) === 1 && bytes.readUInt16LE(22) === 1 && bytes.readUInt32LE(24) === VOICE_SAMPLE_RATE &&
    bytes.readUInt32LE(28) === VOICE_SAMPLE_RATE * 2 && bytes.readUInt16LE(32) === 2 && bytes.readUInt16LE(34) === 16 &&
    bytes.toString('ascii', 36, 40) === 'data' && bytes.readUInt32LE(40) === bytes.length - 44 && (bytes.length - 44) % 2 === 0;
}

function hasAudioSignal(audio) {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let sum = 0;
  for (let offset = 44; offset < audio.length; offset += 2) sum += view.getInt16(offset, true) ** 2;
  // Whisper can invent words for silence. Reject near-silent captures before
  // starting it; this is an energy floor, not a speech classification model.
  return Math.sqrt(sum / ((audio.length - 44) / 2)) >= 32;
}

export function voicePaths({ root, packaged = false, resourcesPath, platform = process.platform, arch = process.arch }) {
  const directory = packaged ? path.join(resourcesPath, 'voice') : path.join(root, 'resources', `${platform === 'darwin' ? 'mac' : 'win'}-${arch}`, 'voice');
  return { binary: path.join(directory, platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'), model: path.join(directory, 'ggml-base.en-q5_1.bin') };
}

export class LocalVoice {
  constructor({ binary, model, run = promisify(execFile), temporaryDirectory = tmpdir() }) {
    this.binary = binary;
    this.model = model;
    this.run = run;
    this.temporaryDirectory = temporaryDirectory;
    this.job = null;
    this.disposed = false;
  }

  async status() {
    try {
      await Promise.all([access(this.binary), access(this.model)]);
      return { available: true, name: 'Offline dictation', language: 'en' };
    } catch { return { available: false, reason: 'Offline dictation files are missing. Reinstall Handwork to restore them.' }; }
  }

  async transcribe(audio) {
    if (this.disposed) throw new Error('Dictation is closed.');
    if (!validVoiceAudio(audio)) throw new Error('Invalid dictation audio.');
    if (this.job) throw new Error('Dictation is already being transcribed.');
    if (!hasAudioSignal(audio)) return { text: '' };
    const controller = new AbortController();
    const job = { controller, done: null };
    this.job = job;
    job.done = this.transcribeFile(audio, controller.signal);
    try { return await job.done; }
    finally { if (this.job === job) this.job = null; }
  }

  async transcribeFile(audio, signal) {
    let directory;
    try {
      const status = await this.status();
      if (!status.available) throw new Error(status.reason);
      signal.throwIfAborted();
      directory = await mkdtemp(path.join(this.temporaryDirectory, 'handwork-voice-'));
      const input = path.join(directory, 'speech.wav');
      const output = path.join(directory, 'transcript');
      await writeFile(input, audio, { mode: 0o600 });
      signal.throwIfAborted();
      await this.run(this.binary, [
        '-m', this.model, '-f', input, '-l', 'en', '-otxt', '-of', output,
        '-nt', '-np', '-ng', '-sns', // CPU works across supported machines; no GPU allocation.
        '-t', '4',
      ], { signal, timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true });
      signal.throwIfAborted();
      const transcript = (await readFile(`${output}.txt`, 'utf8')).replace(/\s+/g, ' ').trim();
      return { text: transcript };
    } catch (error) {
      if (signal.aborted) throw new Error('Dictation cancelled.');
      if (error.killed || error.code === 'ETIMEDOUT') throw new Error('Dictation took too long. Try a shorter recording.');
      // Native stderr contains paths and model diagnostics; keep it out of UI.
      if (error.code || error.stderr) throw new Error('Could not transcribe audio. Try again or reinstall Handwork if this continues.');
      throw error;
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }

  async cancel() {
    const job = this.job;
    if (!job) return;
    job.controller.abort();
    await job.done.catch(() => {});
  }

  async dispose() { this.disposed = true; await this.cancel(); }
}
