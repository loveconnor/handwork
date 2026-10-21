import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { LocalVoice, validVoiceAudio, voicePaths, MAX_VOICE_BYTES } from '../../electron/local-voice.mjs';
import { voiceWav } from '../../lib/voice-audio.mjs';
import { allowsDesktopPermission, validateArguments } from '../../electron/ipc.mjs';
import { voiceBuildArguments } from '../../scripts/desktop-voice.mjs';

const audio = () => voiceWav([Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 20) / 4)], 48000);

test('capture produces bounded, mono 16 kHz PCM16 audio from 44.1 and 48 kHz devices', () => {
  for (const rate of [44100, 48000]) {
    const wav = voiceWav([new Float32Array(rate).fill(1)], rate);
    assert.equal(wav.length, 32044);
    assert.equal(validVoiceAudio(wav), true);
    assert.equal(new DataView(wav.buffer).getInt16(44, true), 32767);
  }
  const clipped = voiceWav([new Float32Array(16000).fill(-2)], 16000);
  assert.equal(new DataView(clipped.buffer).getInt16(44, true), -32768);
  assert.equal(voiceWav([new Float32Array(16000 * 121)], 16000).length, MAX_VOICE_BYTES);
  assert.throws(() => voiceWav([], 8000), /sample rate/);
});

test('dictation IPC rejects arbitrary bytes, paths, wrong formats, and oversized audio', () => {
  validateArguments('transcribeVoice', [audio()]);
  validateArguments('cancelVoice', []);
  for (const invalid of ['/private/file.wav', [1, 2], {}, new Uint8Array(50), new Uint8Array(MAX_VOICE_BYTES + 2), audio().slice(0, -1)]) {
    assert.equal(validVoiceAudio(invalid), false);
    assert.throws(() => validateArguments('transcribeVoice', [invalid]), /Invalid desktop API/);
  }
  const stereo = audio(); new DataView(stereo.buffer).setUint16(22, 2, true);
  assert.equal(validVoiceAudio(stereo), false);
  assert.throws(() => validateArguments('transcribeVoice', [audio(), '/output']), /Invalid desktop API/);
  assert.throws(() => validateArguments('startVoice', []), /Invalid desktop API/);
});

test('only the trusted main renderer receives microphone permission, never camera access', () => {
  const rendererURL = 'file:///Applications/Handwork.app/Contents/Resources/app.asar/dist/index.html';
  const wc = { isDestroyed: () => false, mainFrame: { url: rendererURL } };
  const check = (permission, details, sender = wc) => allowsDesktopPermission(sender, wc, rendererURL, permission, { isMainFrame: true, requestingUrl: rendererURL, ...details });
  assert.equal(check('media', { mediaType: 'audio' }), true);
  assert.equal(check('media', { mediaTypes: ['audio'] }), true);
  assert.equal(check('clipboard-sanitized-write', {}), true);
  for (const details of [{ mediaType: 'video' }, { mediaTypes: ['audio', 'video'] }, { mediaTypes: [] }, {}, { mediaType: 'audio', isMainFrame: false }, { mediaType: 'audio', requestingUrl: 'https://example.com' }]) {
    assert.equal(check('media', details), false);
  }
  assert.equal(check('media', { mediaType: 'audio' }, { ...wc }), false);
  assert.equal(check('display-capture', { mediaType: 'audio' }), false);
});

async function fixture(runTest) {
  const directory = await mkdtemp(path.join(tmpdir(), 'handwork-voice-test-'));
  try {
    const binary = path.join(directory, 'whisper-cli'); const model = path.join(directory, 'model.bin');
    await writeFile(binary, 'fixture'); await writeFile(model, 'fixture');
    await runTest({ directory, binary, model });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('native transcription uses fixed arguments, normalizes text, and removes temporary audio', async () => fixture(async ({ directory, binary, model }) => {
  let temporary;
  const voice = new LocalVoice({ binary, model, temporaryDirectory: directory, run: async (executable, args, options) => {
    assert.equal(executable, binary);
    assert.equal(args[args.indexOf('-m') + 1], model);
    const input = args[args.indexOf('-f') + 1];
    temporary = path.dirname(input);
    assert.deepEqual(new Uint8Array(await readFile(input)), audio());
    assert.ok(args.includes('-ng'));
    assert.ok(args.includes('-sns'));
    assert.equal(options.windowsHide, true);
    assert.ok(options.signal);
    await writeFile(args[args.indexOf('-of') + 1] + '.txt', ' Hello,\n world. \n');
  } });
  assert.equal((await voice.status()).available, true);
  assert.deepEqual(await voice.transcribe(audio()), { text: 'Hello, world.' });
  await assert.rejects(readdir(temporary), { code: 'ENOENT' });
  assert.deepEqual((await readdir(directory)).sort(), ['model.bin', 'whisper-cli']);
  await voice.dispose();
  await assert.rejects(voice.transcribe(audio()), /closed/);
}));

test('cancelling native transcription aborts work, rejects overlapping work, and cleans audio', async () => fixture(async ({ directory, binary, model }) => {
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const voice = new LocalVoice({ binary, model, temporaryDirectory: directory, run: (_binary, _args, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    started();
  }) });
  const pending = voice.transcribe(audio());
  const rejected = assert.rejects(pending, /cancelled/);
  await running;
  await assert.rejects(voice.transcribe(audio()), /already/);
  await voice.dispose();
  await rejected;
  assert.deepEqual((await readdir(directory)).sort(), ['model.bin', 'whisper-cli']);
}));

test('missing models and native failures leave no recordings behind', async () => fixture(async ({ directory, binary, model }) => {
  const missing = new LocalVoice({ binary, model: path.join(directory, 'missing') });
  assert.equal((await missing.status()).available, false);
  await assert.rejects(missing.transcribe(audio()), /files are missing/);
  for (const nativeError of [Object.assign(new Error('secret paths'), { code: 1, stderr: 'private' }), Object.assign(new Error('timeout'), { killed: true })]) {
    const voice = new LocalVoice({ binary, model, temporaryDirectory: directory, run: async () => { throw nativeError; } });
    await assert.rejects(voice.transcribe(audio()), /Could not transcribe|too long/);
    assert.deepEqual((await readdir(directory)).sort(), ['model.bin', 'whisper-cli']);
  }
}));

test('silence never starts Whisper or inserts its hallucinated words', async () => fixture(async ({ binary, model }) => {
  const voice = new LocalVoice({ binary, model, run: async () => { assert.fail('Silent audio must not launch Whisper'); } });
  assert.deepEqual(await voice.transcribe(voiceWav([new Float32Array(32000)], 16000)), { text: '' });
}));

test('worklet batches samples and flushes its last partial buffer when stopped', async () => {
  const messages = [];
  let Processor;
  const scope = { sampleRate: 48000, Float32Array, AudioWorkletProcessor: class { port = { postMessage: value => messages.push(value) }; }, registerProcessor: (_name, implementation) => { Processor = implementation; } };
  vm.runInNewContext(await readFile(new URL('../../desktop/public/voice-recorder.js', import.meta.url), 'utf8'), scope);
  const processor = new Processor();
  for (let i = 0; i < 20; i++) processor.process([[new Float32Array(128).fill(0.5)]]);
  processor.port.onmessage({ data: 'stop' });
  assert.deepEqual(messages.filter(item => item.samples).map(item => item.samples.length), [2048, 512]);
  assert.equal(messages.at(-1).stopped, true);
  const count = messages.length;
  processor.process([[new Float32Array(128)]]);
  assert.equal(messages.length, count);
});

test('packaged speech assets use the correct executable and static portable builds', () => {
  for (const arch of ['x64', 'arm64']) {
    const target = { platform: 'win32', arch };
    const args = voiceBuildArguments('source', 'build', target);
    assert.equal(args[args.indexOf('-A') + 1], arch === 'arm64' ? 'ARM64' : 'x64');
    assert.ok(args.includes('-DBUILD_SHARED_LIBS=OFF'));
    assert.ok(args.includes('-DGGML_NATIVE=OFF'));
    assert.ok(args.includes('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'));
  }
  assert.deepEqual(voicePaths({ packaged: true, resourcesPath: '/app/resources', platform: 'win32', root: '/unused' }), {
    binary: path.join('/app/resources/voice', 'whisper-cli.exe'), model: path.join('/app/resources/voice', 'ggml-base.en-q5_1.bin'),
  });
});
