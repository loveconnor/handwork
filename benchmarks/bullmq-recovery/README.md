# BullMQ worker recovery benchmark

This is a private mutation benchmark in the full BullMQ repository, not a report of an upstream bug. The pinned upstream revision and mutation hashes are in `fixture.json`. The agent sees a fresh Git repository containing the broken snapshot, with no upstream history. Three related ownership checks are weakened in the seed. Generated scripts and compiled code are rebuilt from that seed before each attempt.

The issue requires rejecting stale completion, failure, immediate retry, delayed retry, single-lock renewal, and batch-lock renewal while preserving current-owner actions, recovery, and retry limits. The prompt gives the behavioral contract and existing-test command, but no affected source paths or reference patch.

## Controls

Unmodified BullMQ passed all ten independent checks. The broken snapshot passed four and failed the six stale-owner checks. A selected existing regression suite contains 268 tests in seven files, all passing on unmodified BullMQ. This is not a claim to run every adapter and integration test in the repository.

The independent evaluator uses real Redis and separate Node worker processes. Lock expiry is controlled with Redis TTLs and observed before recovery. Workers communicate with the evaluator over IPC; no fixed sleep is used as the pass/fail oracle. It checks rejected-operation state, counters, ownership and events, legitimate lock renewal/completion, process death, and retries across worker restarts.

## Comparison protocol

- Five fresh attempts per agent: native Handwork, OpenCode, and Codex.
- gpt-6-astra, low reasoning, 30-minute wall-clock budget per agent attempt.
- Frozen executables, rotated run order, serial execution, preinstalled dependencies, private checkout and Redis process per attempt.
- Personal instructions, skills, MCP settings, and prior histories are blocked. Codex ignores user settings/rules; OpenCode uses pure mode. Product-native instructions and tools still differ.
- A sandbox permits network access only to the attempt's Redis instance and a local model-only proxy. The proxy restricts CONNECT destinations to model-service domains. Handwork uses its existing loopback endpoint override through the same proxy; OpenCode and Codex use HTTPS proxy tunneling. No model responses are rewritten. This adds transport overhead and is documented rather than treated as zero overhead.
- Private checks, reference checkout, benchmark sources, other attempts, and previous benchmark directories are inaccessible to the agents. Network audit logs contain destinations only, not credentials or request bodies.
- The evaluator copies candidate source into a fresh broken checkout with trusted dependencies, rebuilds it, and runs independent checks and the seven-file regression suite. Original non-source tracked files must remain unchanged. Added agent tests are allowed but cannot substitute for the evaluator's tests.
- Every scored attempt counts. Failed attempts and timeouts are retained, not replaced. Preflight failures are setup evidence, not scored attempts.

## Metrics

A complete fix must finish within the time limit, exit successfully, preserve protected files, build from source, and pass all independent and selected existing tests. Time measures the agent process and its own tools/tests, excluding independent post-run grading. Grading status is saved separately. Report solve rate first, then paired successful-attempt time, input/output usage across all attempts, and sampled peak local agent RSS. Test/tool processes, Redis, the model proxy, and hosted inference are not counted as agent RSS. Native tool-call definitions differ across agents.

This repository was not used in earlier Handwork tuning. Public-source familiarity or model pretraining contamination cannot be ruled out. The task and evaluator are locally authored and have not received independent human review. One issue, even with five repetitions, cannot establish an overall harness ranking.

## Evidence

The results directory preserves state, executable hashes, prompt, evaluator snapshots, preflights, ungraded outcomes, source diffs, rebuild logs, independent checks, existing-test output, per-process memory samples, model egress audit, all scored attempts, and summary statistics. Local authentication files are removed after each attempt. Temporary Handwork authentication/settings are restored after each invocation.
