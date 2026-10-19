# Landing-page Handwork refresh

Run five fresh native Handwork attempts on each original landing-page task: pagination, async search, authorization/cache isolation, and BullMQ worker ownership. Preserve the original prompts, fixtures, private verifiers, existing tests, model (`gpt-6-astra`), reasoning (`low`), no-save policy, and 600/1,800-second budgets. Competitors are not rerun. The new page must state the different run dates.

The runner freezes the current macOS ReleaseFast executable and working source, checks small-task fixture and prompt hashes against the September comparison, and restores BullMQ at its recorded upstream revision and mutation hashes. Preparation validates broken/known-correct controls and the 268 selected BullMQ tests. Native read/edit/shell preflights and sandbox denial probes precede scoring. Runs and grading are serial. No tuning occurs during scoring.

The current build treats model and effort as profile-only settings. Each invocation uses a private temporary profile with the original model/effort and a temporary native-session file outside retained evidence. `HANDWORK_AUTH_READ_ONLY=1` disables refresh; sandbox rules deny credential/settings writes. The temporary session file is removed on exit, and original host settings/authentication hashes must remain unchanged. Small tasks copy current managed Handwork skills; BullMQ blocks personal context. No inherited experiment or budget overrides are retained. Normal bounded execution is enabled through the product default.

From the repository root, choose a **new** result directory:

```sh
zig build -Doptimize=ReleaseFast
python3 -B -m unittest discover -s benchmarks/landing-refresh -p 'test_*.py' -v
python3 -B benchmarks/landing-refresh/prepare_bullmq.py benchmarks/orchestration-results/YYYY-MM-DD-landing-refresh
python3 -B benchmarks/landing-refresh/run.py --out benchmarks/orchestration-results/YYYY-MM-DD-landing-refresh
```

Preparation uses the recorded Yarn lockfile with install scripts disabled. It needs Git, Yarn, Node 24, Redis, macOS sandbox-exec, and network access to restore dependencies. The runner requires an existing native login valid beyond each attempt’s budget. It never substitutes another model or refreshes the login.

All 20 scored attempts count, including failures and timeouts. Start, ungraded, and final attempt records use exclusive creation; an existing series cannot be restarted or overwritten. Setup failures remain separate from the scored denominator. Token means include every attempt and remain unavailable if any usage is unavailable. Native JSON usage is reconciled against request accounting. Correctness and accounting availability are distinct. Memory and tool definitions reuse the original sampler and native counters.

After all 20 outcomes are retained, run the sibling site’s `scripts/refresh-handwork-benchmarks.mjs` with the absolute result directory. It independently recomputes aggregates, updates the Handwork row in JavaScript and static HTML, retains every competitor value and archived report, and exports only aggregate figures, safe outcome records, and the method. New raw results stay under the ignored `benchmarks/orchestration-results/` tree.

The original no-save protocol does not expose a persistent subagent host, so these runs exercise the current bounded parent policy rather than saved-session child delegation. The four tasks are development regression coverage, not a fresh holdout or a general agent ranking. Dates, cache state, context, and model variability limit comparisons.

## Separate authorization/cache cohort

The October 19 four-task series is retained in full, including one authorization/cache attempt with unavailable usage during provider transport failures and host sleep. A separate five-attempt cohort obtains complete token accounting without replacing any original attempt or mixing timing and usage from different cohorts:

```sh
caffeinate -i python3 -B benchmarks/landing-refresh/rerun_cache.py --out benchmarks/orchestration-results/2026-10-19-auth-cache-refresh
```

The output directory must not exist. This runner reuses the exact frozen executable, original task and grading helpers, profiles, isolation and 600-second budget. All five scheduled outcomes count. It verifies preserved result hashes, unchanged source and host profiles, and removal of temporary credentials. Keep the lid open; caffeinate prevents idle sleep. The sibling site's `scripts/refresh-auth-cache.mjs` validates all five outcomes and complete usage before updating every metric in the cache row and exporting a separate method report. The earlier four-task report remains unchanged.
