export const SAMPLE_RATE = 16000;
export const MAX_SECONDS = 120;

/** Average source frames into 16 kHz mono and write a standard PCM16 WAV. */
export function voiceWav(chunks, sourceRate) {
  if (!Number.isFinite(sourceRate) || sourceRate < SAMPLE_RATE) throw new Error('Unsupported microphone sample rate.');
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const source = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) { source.set(chunk, offset); offset += chunk.length; }
  const count = Math.min(SAMPLE_RATE * MAX_SECONDS, Math.floor(length * SAMPLE_RATE / sourceRate));
  const wav = new Uint8Array(44 + count * 2);
  const view = new DataView(wav.buffer);
  const label = (index, text) => { for (let i = 0; i < text.length; i++) wav[index + i] = text.charCodeAt(i); };
  label(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); label(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true); view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * sourceRate / SAMPLE_RATE);
    const end = Math.floor((i + 1) * sourceRate / SAMPLE_RATE);
    let sample = 0;
    for (let frame = start; frame < end; frame++) sample += source[frame];
    sample = Math.max(-1, Math.min(1, sample / (end - start)));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return wav;
}
