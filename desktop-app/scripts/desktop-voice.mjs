import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopTarget, assertEngineTarget } from './desktop-engine.mjs';

const run = promisify(execFile);
const WHISPER_TAG = 'v1.9.5';
const WHISPER_COMMIT = 'd1be6fde11ac6e0407606b4e42fe72d34add8037';
const MODEL = 'ggml-base.en-q5_1.bin';
const MODEL_SHA256 = '4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f';
const MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hashFile = async file => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

async function stageModel(cache) {
  const model = path.join(cache, MODEL);
  try { if (await hashFile(model) === MODEL_SHA256) return model; } catch { /* First build. */ }
  console.log('Downloading the 60 MB offline English dictation model (build time only)…');
  const temporary = model + '.download';
  try {
    const response = await fetch(`https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/${MODEL}`, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
    await pipeline(response.body, createWriteStream(temporary));
    if (await hashFile(temporary) !== MODEL_SHA256) throw new Error('Offline speech model checksum mismatch.');
    await rename(temporary, model);
    return model;
  } finally { await rm(temporary, { force: true }); }
}

export function voiceBuildArguments(source, build, target) {
  return ['-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_SERVER=OFF',
    '-DWHISPER_CURL=OFF', '-DGGML_NATIVE=OFF', '-DGGML_METAL=OFF', '-DGGML_OPENMP=OFF',
    '-DGGML_AVX=OFF', '-DGGML_AVX2=OFF', '-DGGML_FMA=OFF', '-DGGML_F16C=OFF',
    ...(target.platform === 'darwin' ? ['-DCMAKE_OSX_ARCHITECTURES=arm64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0'] : ['-G', 'Visual Studio 17 2022', '-A', target.arch === 'arm64' ? 'ARM64' : 'x64', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded']),
  ];
}

/** Build the small CPU runtime, then stage all assets outside app.asar. No runtime downloads. */
export async function stageVoice(projectRoot = root, target = desktopTarget()) {
  const cache = path.join(projectRoot, 'resources', 'voice-build');
  const source = path.join(cache, 'source');
  const build = path.join(cache, `${target.platform}-${target.arch}-${WHISPER_TAG}`);
  const destination = path.join(projectRoot, 'resources', target.directory, 'voice');
  await mkdir(cache, { recursive: true });
  await mkdir(destination, { recursive: true });
  const binaryName = target.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const builtBinary = path.join(build, 'bin', ...(target.platform === 'win32' ? ['Release'] : []), binaryName);
  const manifest = JSON.stringify({ version: WHISPER_COMMIT, target, cpu: true, model: MODEL_SHA256 });
  const override = process.env.HANDWORK_WHISPER_BINARY;
  let ready = false;
  try { ready = (await readFile(path.join(build, 'handwork-build.json'), 'utf8')) === manifest; await access(builtBinary); } catch { ready = false; }
  if (!override && !ready) {
    if (target.platform !== process.platform) throw new Error('Build offline dictation on its target OS, or set HANDWORK_WHISPER_BINARY to a static whisper-cli built for that target.');
    try { await access(path.join(source, 'CMakeLists.txt')); }
    catch {
      await rm(source, { recursive: true, force: true });
      await run('git', ['clone', '--depth', '1', '--branch', WHISPER_TAG, 'https://github.com/ggml-org/whisper.cpp.git', source], { timeout: 180000 });
    }
    const { stdout } = await run('git', ['-C', source, 'rev-parse', 'HEAD']);
    if (stdout.trim() !== WHISPER_COMMIT) throw new Error('Unexpected whisper.cpp source revision. Remove resources/voice-build/source and rebuild.');
    console.log(`Building offline dictation for ${target.platform}-${target.arch}…`);
    await run('cmake', voiceBuildArguments(source, build, target), { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    await run('cmake', ['--build', build, '--config', 'Release', '--target', 'whisper-cli', '--parallel', '4'], { timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(path.join(build, 'handwork-build.json'), manifest);
  }
  const binary = path.resolve(override || builtBinary);
  await assertEngineTarget(binary, target);
  const model = await stageModel(cache);
  await copyFile(binary, path.join(destination, binaryName));
  if (target.platform !== 'win32') { await chmod(path.join(destination, binaryName), 0o755); await run('strip', ['-x', path.join(destination, binaryName)]); }
  await copyFile(model, path.join(destination, MODEL));
  // License text is checked in so an externally built runtime keeps its notices.
  await copyFile(path.join(projectRoot, 'electron', 'voice-NOTICES.txt'), path.join(destination, 'NOTICES.txt'));
  await writeFile(path.join(destination, 'manifest.json'), manifest + '\n');
  console.log(`Offline dictation staged in ${destination}`);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageVoice(root, desktopTarget(process.argv[2] || process.platform, process.argv[3] || process.arch));
}
