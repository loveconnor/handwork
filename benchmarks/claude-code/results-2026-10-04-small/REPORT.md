# Claude Code: Opus 5.5 at medium effort

Five fresh attempts on each of the four existing tasks, run separately on October 4, 2026. Previous Handwork, OpenCode, and Codex results are preserved; they used GPT-6 Astra at low effort. Different models and run dates mean these results do not isolate harness performance.

The three small fixtures match the recorded comparison hashes. BullMQ uses the recorded upstream revision and mutation hashes; broken and known-correct controls passed before scoring. The original task prompts, independent verifiers, existing test suites, and time limits are retained. Every scored attempt is included; failures are not replaced.

Claude Code runs in safe mode with Read, Edit, Write, Bash, Glob, and Grep. Personal instructions, skills, plugins, MCP, saved sessions, private verifiers, benchmark sources, and sibling runs are unavailable. Authentication uses the existing signed-in account. Native read/edit/shell preflight and sandbox isolation probes pass before scoring. Outbound traffic goes through a proxy restricted to Anthropic service domains; local Redis is allowed only for BullMQ.

Time is median wall time among successful attempts, including inference and tools. Tool-call and token figures are means over every attempt. Input tokens include cache creation and cache reads. Tool calls count unique native tool-use IDs. Local agent memory is median sampled peak process RSS, using the existing process sampler; hosted inference is excluded. Client-reported token counts and native tool-call definitions differ between harnesses. These are small local samples.

Versions: 2.1.289 (Claude Code).

| Task | Complete fixes | Median time | Mean tool calls | Mean input tokens | Mean output tokens | Peak agent RSS |
| --- | --- | --- | --- | --- | --- | --- |
| Async search | 5 / 5 | 21.2 s | 3.0 | 37,797 | 2,096 | 275.2 MiB |
| Pagination | 5 / 5 | 12.8 s | 3.8 | 32,898 | 1,032 | 275.7 MiB |
| Authorization and cache isolation | 5 / 5 | 47.9 s | 3.2 | 53,217 | 5,213 | 282.9 MiB |
| BullMQ worker recovery | 5 / 5 | 263.0 s | 19.2 | 748,617 | 10,491 | 307.5 MiB |

| Task | Attempt | Passed | Time (s) |
| --- | --- | --- | --- |
| pagination | 1 | Yes | 13.504 |
| search | 1 | Yes | 24.019 |
| tenant-cache | 1 | Yes | 47.536 |
| pagination | 2 | Yes | 13.095 |
| search | 2 | Yes | 20.315 |
| tenant-cache | 2 | Yes | 49.575 |
| pagination | 3 | Yes | 11.573 |
| search | 3 | Yes | 20.78 |
| tenant-cache | 3 | Yes | 52.57 |
| pagination | 4 | Yes | 12.576 |
| search | 4 | Yes | 21.242 |
| tenant-cache | 4 | Yes | 47.577 |
| pagination | 5 | Yes | 12.835 |
| search | 5 | Yes | 21.666 |
| tenant-cache | 5 | Yes | 47.945 |
| bullmq | 1 | Yes | 262.985 |
| bullmq | 2 | Yes | 438.196 |
| bullmq | 3 | Yes | 252.608 |
| bullmq | 4 | Yes | 237.708 |
| bullmq | 5 | Yes | 280.86 |
