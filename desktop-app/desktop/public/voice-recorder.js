// Runs on Chromium's audio thread, so typing/rendering cannot interrupt capture.
class VoiceRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = 0;
    this.limit = sampleRate * 120;
    this.stopped = false;
    this.buffer = new Float32Array(2048);
    this.used = 0;
    this.port.onmessage = event => {
      if (event.data === 'stop') { this.flush(); this.stopped = true; this.port.postMessage({ stopped: true }); }
    };
  }
  flush() {
    if (!this.used) return;
    const samples = this.buffer.slice(0, this.used);
    this.used = 0;
    this.port.postMessage({ samples }, [samples.buffer]);
  }
  process(inputs) {
    if (this.stopped) return true;
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const count = Math.min(channel.length, this.limit - this.frames);
    for (let i = 0; i < count; i++) {
      this.buffer[this.used++] = channel[i];
      if (this.used === this.buffer.length) this.flush();
    }
    this.frames += count;
    if (this.frames >= this.limit) { this.flush(); this.stopped = true; this.port.postMessage({ limit: true }); }
    return true;
  }
}
registerProcessor('voice-recorder', VoiceRecorder);
