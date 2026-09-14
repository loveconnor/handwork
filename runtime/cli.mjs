#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';

const usage = `Usage: handwork runtime <codex|copilot> <login|models|ask> [--model ID] [--resume ID] [prompt]
Uses the provider's official agent runtime and its own session history.
For ask, omit the prompt to start an interactive conversation. Type /exit to leave.
Codex requires an installed codex CLI. Copilot uses the installed official SDK.
`;
const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) { console.log(usage); process.exit(0); }
const [provider, action, ...rest] = args;
if (!['codex', 'copilot'].includes(provider) || !['login', 'models', 'ask'].includes(action)) {
  console.error(usage); process.exit(2);
}
let model;
let resume;
const words = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--model' || rest[i] === '--resume') {
    const flag = rest[i];
    const value = rest[++i];
    if (!value || value.startsWith('--')) { console.error(`Missing value for ${flag}`); process.exit(2); }
    if (flag === '--model') model = value; else resume = value;
  } else if (rest[i] === '--') { words.push(...rest.slice(i + 1)); break; }
  else if (rest[i].startsWith('--')) { console.error(`Unknown flag: ${rest[i]}`); process.exit(2); }
  else words.push(rest[i]);
}
// Serialize questions because providers may request several approvals concurrently.
let terminal;
let questions = Promise.resolve();
function question(text) {
  const next = questions.then(async () => {
    if (!stdin.isTTY) return '';
    terminal ||= createInterface({ input: stdin, output: stderr });
    return terminal.question(text + '\n> ');
  });
  questions = next.catch(() => {});
  return next;
}
const approve = async request => {
  const answer = await question(`Provider requests permission:\n${JSON.stringify(request, null, 2)}\nAllow this request? [y/N]`);
  return /^(y|yes)$/i.test(answer.trim());
};
let runtime;
let shuttingDown = false;
async function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  terminal?.close();
  const timer = setTimeout(() => process.exit(130), 4000);
  timer.unref();
  try { await runtime?.interrupt(); } catch {}
  try { await runtime?.stop(); } catch {}
  if (signal) process.exit(130);
  clearTimeout(timer);
}
process.on('SIGINT', () => stop(true));
process.on('SIGTERM', () => stop(true));
try {
  const { [provider === 'codex' ? 'CodexRuntime' : 'CopilotRuntime']: Runtime } = await import(`./${provider}.mjs`);
  runtime = new Runtime({ approve, question });
  await runtime.start();
  if (action === 'login') await runtime.login();
  else if (action === 'models') console.log(JSON.stringify(await runtime.models(), null, 2));
  else if (words.length) {
    const id = await runtime.ask(words.join(' '), { model, resume });
    console.error(`Resume: handwork runtime ${provider} ask --resume ${id}`);
  } else {
    if (!stdin.isTTY) throw new Error('Supply a prompt for noninteractive use.');
    while (true) {
      const prompt = await question('Prompt (/exit to leave)');
      if (prompt.trim() === '/exit') break;
      if (!prompt.trim()) continue;
      resume = await runtime.ask(prompt, { model, resume });
    }
  }
} catch (error) {
  console.error(`handwork runtime: ${error.message}`);
  process.exitCode = 1;
} finally { await stop(false); }
