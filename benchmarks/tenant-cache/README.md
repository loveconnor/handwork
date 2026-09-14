# Organization authorization and cache benchmark

This benchmark uses 18 meaningful TypeScript source files, an in-memory database, an injected cache, and no third-party task dependencies. The fixture documents the status codes, actual-owner membership requirement, list parameters, invalidation scope, and cache-use requirements. All harnesses receive the exact prompt saved in `results/prompt.txt`.

The updated Handwork executable was copied and hashed before creating the fixture. OpenCode and Codex are rerun in the same series; earlier scored attempts are not reused. Five rounds rotate harness order, with a 600-second limit and fresh sessions/workspaces. The native Codex code-mode helper is frozen too. Its omission was caught and repaired during preflight, before any scored task; failed preflight evidence is retained separately.

The private verifier has 14 deterministic checks; the existing regression suite is the fifteenth scored check. Complete success requires every check, unchanged original protected files, no installed task dependencies, and completion within budget. New tests are permitted. Diagnostic categories are authorization, cache isolation, invalidation, and regressions; category passes are not partial task success.

Private controls include broken, complete, authorization-only, cache-only, cache-disabled, and clear-all variants. Only the complete repair passes every check. Control patches and verifier source remain outside the agent workspace and outside the served report root. Outcomes are saved in `results/controls.json`.

## Measurements

- Harness/test/other-tool memory uses the same process-tree RSS sampler as earlier benchmarks. The coordinator and report UI are excluded; model-server memory is unavailable.
- All attempts count toward resource means, including failures/timeouts. Time comparisons use shared successful rounds, with pairwise matched medians reported separately.
- OpenCode token and tool usage includes all descendants of the root session in its isolated SQLite database.
- Codex records fresh local rollouts so parent/descendant usage can be deduplicated by response ID. Native tool calls are deduplicated by call ID. Code-mode calls may contain multiple underlying operations.
- Handwork uses the same `--no-save` mode as the earlier benchmark. In this mode its persistent subagent host is unavailable, so root usage is the whole run. Existing trace events count provider admissions; the frozen executable is not rebuilt or instrumented with new code.
- Model-request counts are provider admissions for Handwork, persisted model step starts for OpenCode, and unique usage-bearing response IDs for Codex. Unbilled transport retries are not uniformly exposed. Request counts are distinct from tool counts and are not inferred by adding one to the number of tools.

The macOS sandbox blocks private checks/patches, project benchmark source/results, siblings, earlier benchmark directories, attachments, inbound connections and loopback connections. Hosted provider access is allowed equally. The local report server is stopped while scoring. Hardware/model/reasoning/client-context settings match, but hosted service load and backend hardware cannot be controlled.

Generate `tenant-cache-benchmark-results.html` with `python3 benchmarks/tenant-cache/report.py` after all 15 attempts finish. Raw outcomes, logs, memory samples and diffs are retained under `results/`. Existing benchmark pages are separate and are not replaced by this harder task.

## Final verifier audit

After scoring, an overstrict assertion on cache-read counters was removed: the contract forbids changes to stored data and cache entries, but does not forbid harmless reads. All six controls and fifteen completed workspaces were rechecked with unchanged outcomes, and a correct alternative making a harmless cache read passed. `results/verifier-audit.json` records both verifier hashes and the outcome audit. Task timing, memory and model/tool usage were not changed. The initial verifier and original check outputs are retained.
