# Asynchronous search benchmark

This round runs five attempts each for Handwork, OpenCode and Codex against a search application. Its separate root report is `search-benchmark-results.html`; the pagination report is unchanged.

## Fixture and controls

The fixture contains the requested API, controller, view and basic test files. All request completions initially update shared state without checking request identity. Public controller methods are `getState`, `subscribe`, and async `search`; the view handles input and subscribes to state.

`verify.mjs` is copied into a private directory outside all agent workspaces. It mounts the real view with small element stubs, drives input, and uses the real API adapter with a manually controlled fetch replacement. Resolve/reject operations are followed by awaiting the matching controller promise. There are no timing sleeps, timers or real network requests. Default fetch throws if an implementation tries to bypass injection.

Nine named groups cover the requested behavior, including all six completion permutations for both A → B → A and three distinct requests. The verifier checks controller state, rendered results/loading/errors, and the absence of subscriber emissions on stale completion. Clearing is checked synchronously before awaiting its returned promise.

Before scoring:

- The broken fixture passes 2/9 independent groups and all four existing basic tests.
- A known-correct request identity guard passes 9/9 and the existing tests.
- A query-string-only guard passes 8/9 and the existing tests, but fails A → B → A.

Control variants are never committed into the agent starting history. Every attempt starts at the exact recorded broken commit.

## Harness configuration

The runner reuses `../fixed-budget/pilot.py` for authenticated CLI launching, the corrected sandbox, memory sampling and token/tool parsing. Executable SHA-256 hashes must match the corrected pagination series. The model remains `gpt-6-astra`, reasoning `low`, with 272,000-token client/catalog context. Node 24 executes the TypeScript; there are no task package dependencies to install. OpenCode runtime packages are preinstalled outside the timed interval.

The exact requested prompt is in `results/prompt.txt`. Each attempt gets 300 seconds, a new clone and a fresh session. The five orders are T/O/C, O/C/T, C/T/O, T/C/O and O/T/C; each harness occupies every position once or twice.

Each harness first completes a separate native read/edit/shell probe. The sandbox allows ancestor traversal and blocks the verifier, benchmark source and sibling workspaces, including symlink access. Read/write isolation probes run before each scored attempt. The existing local report server is paused during scoring to prevent HTTP access to verifier files.

## Metrics and scoring

Task success requires completion within budget, all nine independent groups passing, the existing tests passing, protected files unchanged, and no task `node_modules` directory. Protected checks hash tests recursively, package files and harness settings, detecting additions/deletions as well as tracked modifications. Failures and timeouts remain results.

Task time spans process launch with prompt supplied to process exit. The same process sampler as pagination separates harness RSS, test subprocesses and other tools; post-run checks have separate measurements. RSS is sampled, includes shared mappings and can miss short-lived peaks. The report uses median per-attempt peak RSS.

Input/output tokens and native tool invocations use the existing parsers. OpenCode usage now includes parent and descendant sessions read from its saved SQLite database. The original parent-only records are preserved in `results/attempts-parent-only-original.json`; corrected records retain `parent_only_usage` for audit. Counts include reported cached input and reasoning output; they are client-reported, not a server-side billing audit. A fixed OpenCode title avoids auxiliary title generation. Pairwise timing comparisons include only attempt pairs that both harnesses solved.

Hosted model server memory, hardware placement, quantization and cold model startup are unobservable. Five attempts on one fixture are a pilot, not a reliable general ranking. Differences from pagination are descriptive because the tasks differ.

## Evidence and commands

- `results/state.json`: prompt, commit, order, machine and executable hashes.
- `results/verifier-controls.json`: the three control outcomes.
- `results/preflight.json`: native tool and isolation results.
- `results/attempts.json`: all 15 scored attempts.
- `results/*.diff`, `*.stdout`, `*.stderr`, `*.memory.json`, `*.sandbox.sb`: per-attempt evidence.
- `results/report-data.json`: all data embedded in the HTML report.
- `results/*-snapshot.py` and `results/verify-snapshot.mjs`: source snapshots captured before scoring.

The initial run uses `python3 benchmarks/async-search/benchmark.py prepare`, then `preflight` and `run`. Render with `python3 benchmarks/async-search/report_search.py`. Existing scored results cannot be overwritten; use a separate results location for another series.
