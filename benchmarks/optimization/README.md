# Handwork efficiency validation

This change combines related replacements into one `edit_file` call, requests independent reads together, shortens the base prompt and repeated path descriptions, and exposes cache/reasoning usage in CLI JSON. The final revision also limits a read-only execution group to two concurrent tools and asks for concise small-fix summaries and focused supplemental checks.

An edit batch contains at most 32 unique, non-overlapping replacements against the original file, with at most 4 MiB of combined replacement arguments. The runtime resolves all ranges before allocating one postimage, then uses the existing permission, freshness, review, staging and atomic commit path. Legacy `old_string`/`new_string` input still works. No new sidecar, dependency, model agent or persistent connection pool was introduced.

## Validation

- `results/` retains every attempt from the initial five paired runs. The first revision improved time, input tokens and memory; output tokens changed by less than 1%.
- `results-final/` contains a separate set of five alternating frozen/current pairs for the final revision. The same original search commit, exact user prompt, GPT-6 Astra low reasoning, 300-second limit, sandbox, protected files, hidden verifier and process sampler are used for both variants.
- No build or unit-test workload runs concurrently with the scored attempts. The local report server is stopped while scoring so agents cannot retrieve the private verifier over HTTP.
- Each success requires completion within budget, all nine independent check groups passing, the existing tests passing, and protected files unchanged with no dependencies installed.
- `focused-tests.log` records 163 passing checks, including allocation-failure cleanup, batch range rejection, a fixed-buffer test that fits exactly one postimage, and bounded read-only grouping.
- The early full suite contained outdated prompt/schema snapshots plus 30 unrelated failures. Those 30 failures were reproduced against both pre-change and current source; the matching lists and raw logs are saved in `unrelated-test-audit.json` and the two `*-unrelated-tests.log` files. The full suite is not claimed clean.

Token totals and tool calls are reported across all attempts; completion medians use matched successes. Memory is median and maximum sampled peak harness RSS. Test and tool subprocess peaks are separate in the JSON. These are small-fixture observations, not a guarantee of identical memory or speed on every workload.

## Reproduce and review

The runners refuse to overwrite scored data. From the project root, use `python3 benchmarks/optimization/run.py NAME` for a new results directory, after building and stopping the report server. The runner copies both executables into an isolated temporary directory and records hashes. Model credentials are staged only while needed and restored/removed afterward.

`implementation.diff` contains the source changes. `report.py results-final` generates the root `handwork-optimization-results.html`; `report.py` generates the preserved initial report. Raw runs, diffs, independent verification, protected-file checks, memory samples and frozen source files live in the corresponding results directory.

The OpenCode accounting helper now reads parent and descendant sessions from its saved SQLite database, excluding unrelated sessions. `test_accounting.py` checks nested descendants, totals and exclusion. The separate search report was corrected from its retained databases; original parent-only totals remain available for audit.
