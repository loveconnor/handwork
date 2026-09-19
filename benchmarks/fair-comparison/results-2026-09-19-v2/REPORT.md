# Fresh five-attempt harness comparison

Run started: 2026-09-18T21:12:00-0400. Model: gpt-6-astra; reasoning: low. Five attempts per agent per task; 600-second limit per attempt.

All three agents were rerun in the same series. Runs were serial with rotated agent order, fresh workspaces, and fresh sessions. Executables were frozen before preflight. No scored outcomes were discarded or replaced.

| Task | Agent | Complete fixes | Median successful time | Mean tool calls | Mean input tokens | Mean output tokens | Median peak agent RSS |
|---|---|---:|---:|---:|---:|---:|---:|
| pagination | handwork | 5/5 | 25.4 s | 5.0 | 27,880.2 | 462.0 | 21.9 MiB |
| pagination | opencode | 5/5 | 41.7 s | 11.0 | 42,015.8 | 734.4 | 748.2 MiB |
| pagination | codex | 5/5 | 28.0 s | 3.4 | 66,153.2 | 566.4 | 237.7 MiB |
| search | handwork | 5/5 | 40.6 s | 5.0 | 37,086.6 | 991.8 | 23.7 MiB |
| search | opencode | 5/5 | 55.2 s | 15.8 | 78,781.2 | 1,138.8 | 790.1 MiB |
| search | codex | 5/5 | 32.8 s | 4.2 | 82,758.2 | 763.4 | 234.0 MiB |
| tenant-cache | handwork | 5/5 | 86.1 s | 8.4 | 71,894.8 | 2,136.2 | 27.3 MiB |
| tenant-cache | opencode | 5/5 | 121.6 s | 24.2 | 115,747.8 | 3,056.8 | 785.3 MiB |
| tenant-cache | codex | 5/5 | 83.5 s | 6.2 | 129,680.2 | 2,236.0 | 235.1 MiB |

## Method and limitations

Success requires completion within the time limit, a zero exit status, all independent behavioral checks and existing tests passing, protected files preserved, and no installed task dependencies. Broken and known-correct fixture controls and separate tool-access preflights passed before scoring. The sandbox blocks private checks, benchmark sources, prior benchmark workspaces, and loopback network access.

Time includes model inference, network latency, and tools. Time is the median across successful attempts; token and tool counts are means across every attempt, including failures. RSS is sampled peak local agent memory, excluding hosted inference and separately classified test/tool processes. Tool-call definitions differ between harnesses; a shell command or code-mode call may contain several operations. Tokens are client-reported, include cache hits, and include saved descendant activity where available. No dollar-cost comparison is claimed.

These are five-attempt pilots on three small local TypeScript fixtures, not a general agent ranking or a public leaderboard. Prompts, model, budgets, fixtures, and scoring match, but harness instructions and native tools differ. Handwork inherits existing personal context; Codex ignores user rules; OpenCode runs in pure mode. This is not a pristine common profile.

The earlier two-attempt Handwork series and historical competitor results are separate measurements and are not mixed into this report.

## Frozen executable hashes

- handwork: `90d8b7dddf0c14f2c329577bec1fc175ee44a55fdeb6758e1dc92dfb312ef178`
- opencode: `16c960ba77421da11b53e785f359b73f328a86118b48feb4af143db5d9afb198`
- codex: `805f2102d573c580d8cad2fc774b81837e68f7e9bdd1adb559d67801bbc1f9bd`
- codex-code-mode-host: `685d71198d94d06a886c8edfc0fa02aa72efb32bbc5bfafe1210b96b1abd361a`

## Failures

None. All 45 scored attempts passed.
