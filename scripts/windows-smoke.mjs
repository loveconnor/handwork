// Also runs on macOS to check the harness. Windows execution remains required.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve(process.argv[2] ?? join('zig-out', 'bin', process.platform === 'win32' ? 'handwork.exe' : 'handwork'));
const root = await mkdtemp(join(tmpdir(), 'handwork smoke 日本語 '));
const home = join(root, 'home with spaces');
const workspace = join(root, 'workspace 日本語');
await mkdir(home);
await mkdir(workspace);
const command = process.platform === 'win32' ? 'echo command-ok> "result 日本語.txt"' : 'printf command-ok > "result 日本語.txt"';
const backgroundCommand = process.platform === 'win32'
  ? 'ping -n 3 127.0.0.1 >nul\r\necho background-ok> "background 日本語.txt"'
  : 'sleep 2; printf background-ok > "background 日本語.txt"';
let completions = 0;
let requests = 0;
function sse(events) {
  return events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
}
const completed = { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 5 } };
const textDelta = text => ({ choices: [{ delta: { content: text }, finish_reason: null }] });
function toolResponse(id, request) {
  return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ request }) } }] }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]']);
}
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (request.url.startsWith('/models')) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'gpt-test' }] }));
      return;
    }
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    requests++;
    response.setHeader('content-type', 'text/event-stream');
    if (body.includes('Generate a short title')) {
      response.end(sse([textDelta('Platform smoke'), completed, '[DONE]']));
      return;
    }
    const step = completions++;
    if (step === 0) {
      response.end(toolResponse('platform_command', { action: 'run', command, tty: false, timeout_ms: 10000, yield_time_ms: 30000 }));
    } else if (step === 1) {
      response.end(toolResponse('platform_background', { action: 'run', command: backgroundCommand, tty: false, timeout_ms: 10000, yield_time_ms: 0 }));
    } else if (step === 2) {
      const toolResult = JSON.parse(body).messages.filter(message => message.role === 'tool').at(-1)?.content;
      assert.equal(typeof toolResult, 'string');
      assert.match(toolResult, /"state"\s*:\s*"running"/);
      const sessionId = /"session_id"\s*:\s*"([^"]+)"/.exec(toolResult)?.[1];
      assert.ok(sessionId, 'background command must return its session ID');
      response.end(toolResponse('platform_collect', { action: 'interact', session_id: sessionId, yield_time_ms: 30000 }));
    } else {
      response.end(sse([textDelta('platform-smoke-ok'), completed, '[DONE]']));
    }
  } catch (error) { response.writeHead(500).end(error.message); }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const base = `http://127.0.0.1:${server.address().port}`;
const env = {
  ...process.env, HOME: home, USERPROFILE: home,
  HANDWORK_AUTH_MODE: 'local', OPENAI_API_KEY: 'smoke-fixture-key', HANDWORK_OPENAI_BASE_URL: base, HANDWORK_DISABLE_KEYCHAIN: '1', HANDWORK_AUTO_UPGRADE: '0',
  HANDWORK_E2E_DISABLE_DOTENV: '1', HANDWORK_MODEL: 'gpt-test',
  HANDWORK_E2E_OPENAI_CODEX_MODELS_URL: `${base}/models`,
  HANDWORK_E2E_OPENAI_CODEX_RESPONSES_URL: `${base}/responses`,
  HANDWORK_E2E_CODEX_CLIENT_VERSION: '0.153.0',
};
function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = binary.endsWith('.cjs')
      ? spawn(process.execPath, [binary, ...args], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(binary, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out: ${args.join(' ')}`)); }, 45000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`CLI exited ${code}: ${stderr}\n${stdout}`));
      else resolveRun({ stdout, stderr });
    });
  });
}
try {
  assert.match((await run(['--version'])).stdout, /^\d+\.\d+\.\d+/);
  assert.match((await run(['--help'])).stdout, /handwork/i);
  await run(['login', 'openai']);
  const first = JSON.parse((await run(['ask', '--json', '--yolo', 'Run the fixture command and reply.'])).stdout);
  assert.ok(first.session_id, 'ask must save a session');
  assert.match(JSON.stringify(first), /platform-smoke-ok/);
  assert.match(await readFile(join(workspace, 'result 日本語.txt'), 'utf8'), /command-ok/);
  assert.match(await readFile(join(workspace, 'background 日本語.txt'), 'utf8'), /background-ok/);
  const second = JSON.parse((await run(['ask', '--json', '--yolo', '--resume-id', first.session_id, 'Continue this session.'])).stdout);
  assert.equal(second.session_id, first.session_id);
  assert.match(JSON.stringify(second), /platform-smoke-ok/);
  assert.ok(requests >= 5);
  console.log(`PASS ${process.platform}-${process.arch}: launch, loopback provider, shell and background tools, Unicode files, saved session and resume`);
} finally {
  server.closeAllConnections();
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}
