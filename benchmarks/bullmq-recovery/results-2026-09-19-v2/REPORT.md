# BullMQ worker recovery results

Complete series.

Repository: BullMQ 6.3.8, upstream revision `0b85d6b94d9eaf0e05a6453ee05f6737cd2cde39`. This is a private injected regression, not an upstream bug report.

Model: gpt-6-astra, reasoning low. Five planned attempts per agent, 1,800-second budget per attempt. Started 2026-09-18T23:08:24-0400.

| Agent | Complete fixes | Median successful time | Mean input tokens | Mean output tokens | Mean tool calls | Median peak agent RSS |
|---|---:|---:|---:|---:|---:|---:|
| handwork | 5/5 | 251.5 s | 477,491.2 | 2,939.0 | 25.8 | 30.6 MiB |
| opencode | 5/5 | 446.9 s | 539,156.0 | 4,461.8 | 30.8 | 778.7 MiB |
| codex | 5/5 | 231.6 s | 623,398.6 | 3,643.6 | 20.2 | 205.8 MiB |

## Paired successful attempts

- handwork versus opencode: 5 pairs; total agent time difference -41.5%.
- handwork versus codex: 5 pairs; total agent time difference +2.4%.

## Individual outcomes

| Round | Agent | Agent time | Independent checks | Existing suite | Complete fix |
|---:|---|---:|---:|---|---|
| 1 | handwork | 251.5 s | 10/10 | pass | pass |
| 1 | opencode | 458.3 s | 10/10 | pass | pass |
| 1 | codex | 231.6 s | 10/10 | pass | pass |
| 2 | opencode | 446.9 s | 10/10 | pass | pass |
| 2 | codex | 247.1 s | 10/10 | pass | pass |
| 2 | handwork | 251.6 s | 10/10 | pass | pass |
| 3 | codex | 196.9 s | 10/10 | pass | pass |
| 3 | handwork | 280.1 s | 10/10 | pass | pass |
| 3 | opencode | 454.9 s | 10/10 | pass | pass |
| 4 | handwork | 183.2 s | 10/10 | pass | pass |
| 4 | codex | 219.1 s | 10/10 | pass | pass |
| 4 | opencode | 341.6 s | 10/10 | pass | pass |
| 5 | opencode | 350.4 s | 10/10 | pass | pass |
| 5 | handwork | 234.9 s | 10/10 | pass | pass |
| 5 | codex | 278.7 s | 10/10 | pass | pass |

## Controls and protocol

Unmodified BullMQ passed 10/10 independent checks and 268 existing tests across seven selected files. The injected regression failed six stale-owner checks while passing crash recovery and retry controls. Independent checks use separate worker processes, real Redis lock expiry, and IPC-driven state transitions. This does not cover every BullMQ adapter or integration suite.

Agents used a fresh broken repository without upstream history and preinstalled dependencies. Binaries, prompts, fixtures, evaluator and budgets were frozen before scoring. Agent order rotates across rounds. Personal instructions, skills, MCP settings and histories are blocked. Native system prompts and tool designs differ.

Network access is limited to local Redis and a model-only proxy. The proxy permits model-service domains, not source-code hosts. Handwork uses its existing loopback endpoint overrides through the proxy; OpenCode and Codex use HTTPS tunneling. This introduces transport overhead and is not identical to an unrestricted production environment. Proxy audit logs contain destinations only.

Each candidate is rebuilt from source in a fresh checkout with trusted dependencies, then graded independently. A complete fix requires successful completion within budget, protected files preserved, a clean build, all 10 independent checks, and the selected existing suite. Every scored outcome is retained.

Time includes the agent and its own tools/tests, but excludes setup and independent post-run grading. Token/tool means include failures. Memory is sampled local agent RSS, excluding tools/tests, Redis, proxy, and hosted inference. Tool-call definitions differ between harnesses.

This is one locally authored task in a real repository, not a public benchmark score or general ranking. The evaluator has not received independent human review. The repository was not used in prior Handwork tuning; model familiarity with public code cannot be ruled out. No harness tuning occurs during this scored series.

## Frozen executable hashes

- handwork: `90d8b7dddf0c14f2c329577bec1fc175ee44a55fdeb6758e1dc92dfb312ef178`
- opencode: `16c960ba77421da11b53e785f359b73f328a86118b48feb4af143db5d9afb198`
- codex: `805f2102d573c580d8cad2fc774b81837e68f7e9bdd1adb559d67801bbc1f9bd`
- codex-code-mode-host: `685d71198d94d06a886c8edfc0fa02aa72efb32bbc5bfafe1210b96b1abd361a`
