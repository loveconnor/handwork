# Fresh five-attempt comparison

This series reruns Handwork, OpenCode, and Codex on the same pagination, async-search, and authorization/cache fixtures. Each agent gets five attempts per task and a 600-second wall-clock limit per attempt. The model is gpt-6-astra with low reasoning. Agent order rotates across rounds and tasks. Runs are serial, with fresh workspaces and sessions.

Executable copies and hashes are frozen before preflight. Broken and known-correct fixture controls must pass their expected checks. Each agent must complete a separate native read/edit/shell probe before scoring. OpenCode runtime packages and catalog caches from its probe are copied outside the scored interval. A macOS sandbox blocks benchmark sources, private verifiers, sibling workspaces, previous benchmark directories, and loopback network access. Leaf and symlink isolation probes run before each attempt.

Success requires completion within budget, a zero exit status, the independent verifier, existing tests, preserved protected files, and no installed task dependencies. Authorization/cache permits added tests but protects existing tests. Every scored outcome is retained; failures are never replaced to reach five successes.

Time includes model inference, network latency, and tools. Time summaries are medians of successful attempts; token and tool figures are means across all attempts. Memory is median sampled peak local agent RSS, excluding hosted inference and separately classified test/tool processes. Tokens are client-reported; OpenCode descendant sessions and Codex saved rollouts are included in accounting. These are small local pilots, not general rankings or public leaderboard results.

Harness defaults differ: Handwork inherits the existing personal context, Codex ignores user rules, and OpenCode uses pure mode. These runs match model, fixtures, budgets, sample counts, and scoring, but do not claim identical system prompts or pristine configuration. No tuning occurs during scored runs.

Run with a new output directory:

```sh
python3 benchmarks/fair-comparison/run.py benchmarks/fair-comparison/results-YYYY-MM-DD
```

The output includes frozen runner dependencies, executable/fixture hashes, controls, preflight records, all attempts, diffs, verification output, memory samples, and a summary. Raw traces stay local; only the report and aggregate summary are copied to the landing-page project.
