import fs from 'node:fs';
import path from 'node:path';
const [smallPath, bullPath, sitePath] = process.argv.slice(2).map(p => path.resolve(p));
const small = JSON.parse(fs.readFileSync(path.join(smallPath, 'summary.json')));
const bull = JSON.parse(fs.readFileSync(path.join(bullPath, 'summary.json')));
const summary = { ...small, ...bull };
const attempts = [smallPath, bullPath].flatMap(p => JSON.parse(fs.readFileSync(path.join(p, 'attempts.json'))));
const tasks = { search: 'search', pagination: 'pagination', cache: 'tenant-cache', bullmq: 'bullmq' };
if (attempts.length !== 20 || Object.values(tasks).some(task => summary[task]?.attempts !== 5)) throw Error('Incomplete series');
const read = p => fs.readFileSync(path.join(sitePath, p), 'utf8');
const write = (p, body) => fs.writeFileSync(path.join(sitePath, p), body);
let js = read('public/app.js');
const match = js.match(/const datasets = (\{[\s\S]*?\n\});/);
if (!match) throw Error('Dataset declaration missing');
const datasets = JSON.parse(match[1]);
for (const [key, task] of Object.entries(tasks)) {
  if (datasets[key].values.length !== 3) throw Error('Expected three existing rows');
  const v = summary[task];
  const value = { attempts: v.attempts, fixes: v.successes, time: v.median_success_seconds,
    toolCalls: v.mean_tool_calls, inputTokens: v.mean_input_tokens, outputTokens: v.mean_output_tokens, rss: v.median_peak_mib };
  datasets[key].values.push(value);
}
js = js.replace(match[0], `const datasets = ${JSON.stringify(datasets, null, 2)};`);
// Failed series must have an honest unavailable time, rather than a fabricated zero.
js = js.replace('time: `${agent.time.toFixed(1)} s`,', 'time: agent.time === null ? "—" : `${agent.time.toFixed(1)} s`,');
js = js.replace('const scale = key === \'fixes\' ? agent.fixes / (agent.attempts ?? data.attempts) : agent[key] / maxima[key];',
  'const scale = key === \'fixes\' ? agent.fixes / (agent.attempts ?? data.attempts) : (agent[key] ?? 0) / (maxima[key] || 1);');
write('public/app.js', js);
const format = a => ({ fixes: `${a.fixes} / ${a.attempts}`, time: a.time === null ? '—' : `${a.time.toFixed(1)} s`,
  toolCalls: a.toolCalls.toFixed(1), inputTokens: Math.round(a.inputTokens).toLocaleString('en-US'),
  outputTokens: Math.round(a.outputTokens).toLocaleString('en-US'), rss: `${a.rss.toFixed(1)} MiB` });
let html = read('src/index.html');
const tbody = html.match(/<tbody id="benchmark-rows">([\s\S]*?)<\/tbody>/);
const rows = tbody[1].match(/<tr\b[\s\S]*?<\/tr>/g);
if (rows.length !== 3) throw Error('Expected three static rows');
let claudeRow = rows[2].replace(/<th scope="row">[\s\S]*?<\/th>/, '<th scope="row"><span class="agent-label"><img class="agent-logo" src="/media/logos/claude.svg" alt="" width="18" height="18"><span>Claude Code</span></span></th>');
const allRows = [...rows, claudeRow].map((row, index) => {
  const value = datasets.search.values[index];
  const formatted = format(value);
  for (const key of Object.keys(formatted)) {
    const scale = key === 'fixes' ? value.fixes / value.attempts : (value[key] ?? 0) / (Math.max(...datasets.search.values.map(a => a[key] ?? 0)) || 1);
    const re = new RegExp(`(data-metric="${key}"[\\s\\S]*?--bar-scale:)[^";]+("[\\s\\S]*?class="metric-value">)[^<]+`);
    row = row.replace(re, (_, start, middle) => start + Number(scale.toFixed(6)) + middle + formatted[key]);
  }
  return row;
});
html = html.replace(tbody[0], `<tbody id="benchmark-rows">\n${allRows.map(row => '          ' + row).join('\n')}\n        </tbody>`);
html = html.replace('Five fresh attempts per agent on each of four coding tasks. For each task, all three agents used the same model, time limit, prompt, and independent checks.',
  'Five attempts per agent on each of four coding tasks. Claude Code was added in a separate series with a different model. All agents used the same task prompts, time limits, and independent checks.');
html = html.replace('Each agent had five attempts per task with the same time limit. We rotated the run order and kept every result.',
  'Each agent had five attempts per task with the same time limit. The original three agents ran in rotated order; Claude Code ran separately on October 4, 2026. We kept every result.');
html = html.replace('The model was gpt-6-astra with low reasoning and a 272,000 token context limit.',
  'Handwork, OpenCode, and Codex used GPT-6 Astra with low reasoning and a 272,000 token context limit. Claude Code used Opus 5.5 at medium effort with its reported 1,000,000 token context window. These results compare different models and run dates, so they do not isolate harness performance.');
write('src/index.html', html);
const destination = path.join(sitePath, 'public/benchmarks/claude-code');
fs.mkdirSync(destination, { recursive: true });
const method = { date: '2026-10-04', harness: 'Claude Code', model: 'claude-opus-5-5', effort: 'medium',
  versions: [smallPath, bullPath].map(p => JSON.parse(fs.readFileSync(path.join(p, 'state.json'))).claude_version),
  budgets: { pagination: 600, search: 600, 'tenant-cache': 600, bullmq: 1800 },
  inputTokenBasis: 'Client-reported input, cache creation, and cache read tokens combined',
  comparison: 'Separate run dates and different models; previous rows preserved. Not a controlled comparison of harness performance.' };
fs.writeFileSync(path.join(destination, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(path.join(destination, 'method.json'), JSON.stringify(method, null, 2) + '\n');
const lines = ['# Claude Code: Opus 5.5 at medium effort', '',
  'Five fresh attempts on each of the four existing tasks, run separately on October 4, 2026. Previous Handwork, OpenCode, and Codex results are preserved; they used GPT-6 Astra at low effort. Different models and run dates mean these results do not isolate harness performance.', '',
  'The three small fixtures match the recorded comparison hashes. BullMQ uses the recorded upstream revision and mutation hashes; broken and known-correct controls passed before scoring. The original task prompts, independent verifiers, existing test suites, and time limits are retained. Every scored attempt is included; failures are not replaced.', '',
  'Claude Code runs in safe mode with Read, Edit, Write, Bash, Glob, and Grep. Personal instructions, skills, plugins, MCP, saved sessions, private verifiers, benchmark sources, and sibling runs are unavailable. Authentication uses the existing signed-in account. Native read/edit/shell preflight and sandbox isolation probes pass before scoring. Outbound traffic goes through a proxy restricted to Anthropic service domains; local Redis is allowed only for BullMQ.', '',
  'Time is median wall time among successful attempts, including inference and tools. Tool-call and token figures are means over every attempt. Input tokens include cache creation and cache reads. Tool calls count unique native tool-use IDs. Local agent memory is median sampled peak process RSS, using the existing process sampler; hosted inference is excluded. Client-reported token counts and native tool-call definitions differ between harnesses. These are small local samples.', '',
  `Versions: ${[...new Set(method.versions)].join(', ')}.`, '',
  '| Task | Complete fixes | Median time | Mean tool calls | Mean input tokens | Mean output tokens | Peak agent RSS |',
  '| --- | --- | --- | --- | --- | --- | --- |'];
for (const [key, task] of Object.entries(tasks)) {
  const f = format(datasets[key].values[3]);
  lines.push(`| ${datasets[key].label} | ${Object.values(f).join(' | ')} |`);
}
lines.push('', '| Task | Attempt | Passed | Time (s) |', '| --- | --- | --- | --- |');
for (const a of attempts) lines.push(`| ${a.task} | ${a.attempt} | ${a.success ? 'Yes' : 'No'} | ${a.duration_s} |`);
const report = lines.join('\n') + '\n';
fs.writeFileSync(path.join(destination, 'REPORT.md'), report);
fs.writeFileSync(path.join(smallPath, 'REPORT.md'), report);
for (const source of ['fair-comparison', 'bullmq-recovery']) {
  const summaryPath = `public/benchmarks/${source}/summary.json`;
  const current = JSON.parse(read(summaryPath));
  if (source === 'fair-comparison') {
    for (const task of ['pagination', 'search', 'tenant-cache']) current[task].claude = summary[task];
  } else current.claude = summary.bullmq;
  write(summaryPath, JSON.stringify(current, null, 2) + '\n');
  const reportPath = `public/benchmarks/${source}/REPORT.md`;
  write(reportPath, read(reportPath) + '\n## Claude Code addition — October 4, 2026\n\nClaude Code was added in a separate five-attempt series using Opus 5.5 at medium effort. The existing results above used GPT-6 Astra at low effort and remain unchanged. These are different models and run dates, so the combined table does not isolate harness performance. [Read the Claude Code method and all attempts](/benchmarks/claude-code/REPORT.md).\n');
}
write('README.md', read('README.md') + '\nClaude Code was added on October 4, 2026 with Opus 5.5 at medium effort, five attempts per task. Previous values are preserved. The method and aggregate results are in `public/benchmarks/claude-code/`; combined report downloads include the fourth row. Models and run dates differ.\n');
console.log('Added Claude Code to four task datasets and the static table; previous metric values preserved.');
