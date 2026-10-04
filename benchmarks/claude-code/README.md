# Claude Code addition

This series adds Claude Code 2.1.289 using `claude-opus-5-5` at medium effort to the existing landing-page results. Each task has five fresh attempts. Previous results are preserved and used GPT-6 Astra at low effort; this is a comparison across different models and run dates, not a controlled measurement of harness performance.

The runner uses the existing small-task fixture builders and independent graders, checks fixture hashes against the recorded comparison, and retains every attempt. The restored BullMQ fixture uses its recorded upstream revision and mutation hashes, a frozen Yarn lockfile, and broken/known-correct controls. Native read/edit/shell probes and sandbox isolation probes run before scoring. Only Anthropic service domains and, for BullMQ, its isolated local Redis instance are reachable.

Run the small tasks with a new output directory:

```sh
python3 benchmarks/claude-code/run.py --out benchmarks/claude-code/results-YYYY-MM-DD-small
```

Restore BullMQ and validate both controls before its scored series:

```sh
python3 benchmarks/claude-code/prepare-bullmq.py
python3 benchmarks/claude-code/check-bullmq.py
python3 benchmarks/claude-code/run.py --tasks bullmq --bullmq-state benchmarks/claude-code/bullmq-state-2026-10-04.json --out benchmarks/claude-code/results-YYYY-MM-DD-bullmq
```

The preparation scripts currently target the October 4, 2026 series. Local workspaces and dependencies are not published. Claude Code uses safe mode and six native tools with MCP and persisted sessions disabled. Existing account authentication stays in its original store and is not copied into evidence. Token accounting includes input, cache creation, and cache reads; the tests protect this accounting and reject unexpected models.

Once all 20 attempts have been scored, update the site:

```sh
node benchmarks/claude-code/update-site.mjs benchmarks/claude-code/results-YYYY-MM-DD-small benchmarks/claude-code/results-YYYY-MM-DD-bullmq ../handwork-site
```

The updater refuses incomplete series or an already-added fourth row. It updates both the JavaScript datasets and static table, preserves previous metric values, labels the model difference, and copies only aggregate results and method reports. Raw traces stay local.
