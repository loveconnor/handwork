# Implementation and verification status

## Default rollout — October 19, 2026

The user requested enabling the tested bounded-delegation behavior by default. Normal runs now use compact built-in parent/child operating policies, instruction-loading receipts, bounded child evidence and bounded CLI overlap without an environment flag. Explicit `HANDWORK_EXPERIMENT_BOUNDED_DELEGATION=0` restores the original behavior; `=1` remains compatible. Custom prompts retain their exact host policy, and the other experimental controls remain off unless enabled.

The latest v20 comparison retained 28 correct, eligible attempts across the six-task study and the separate delegation case. Pagination input/output changed by −21.16%/−4.31%, stream by −28.04%/−1.00%, and delegation by −1.28%/−15.52%; median latency changed by −15.48%, −9.18%, and −21.97%, respectively. The separate delegation case passed its gates. The six-task study still failed output gates for queue (+1.67%) and ledger (+3.87%). The default change is an explicit rollout decision, not an all-gates promotion claim. See the preserved [v20 report](../orchestration-results/2026-10-19-bounded-delegation-v20/RESULTS.md).

Future benchmark freezes use protocol version 2 and explicitly pin the original bounded-mode-off baseline in the common executor environment, with candidate controls applied afterward. Task definitions, scoring and budgets are unchanged. All existing result files, failed runs and frozen sources remain on disk under the ignored `benchmarks/orchestration-results/` directory.

Validation passed with Zig 0.16.0: native macOS and aarch64 Linux ReleaseFast builds; focused `bounded prompt`, `bounded delegation` and `automatic instruction loading` Zig checks; and all 68 Python checks with the real Docker backend and rebuilt Linux binary. Native tests used a synthetic provider to verify default-on activation, explicit `=1` compatibility, `=0` rollback, child evidence, bounded overlap and cancellation. The full Zig suite was not rerun; historical broader-suite failures below remain outside this validation.

All 43,100 saved result files matched their pre-rollout SHA-256 hashes. The Git index was unchanged, and the new ignore rule reduced the visible change list to 55 source/configuration/study files.

## Historical verification — October 18, 2026

The following records describe the earlier opt-in implementation. The original verification below predates the container executor.

## Container executor follow-up

`container_executor.py` now provides live isolated execution using a frozen Linux image and binary. Actual Docker integration checks passed for all six broken/known-correct fixture pairs, host/private/sibling denial, and detached descendant cleanup after timeout and successful leader exit. The suite passed 56 tests with the real Docker backend enabled, including controls inside another Git repository and native rejection of expired read-only credentials. The focused Zig read-only subscription and subscription catalog checks also passed. A separate diagnostic native request returned `READY` using `gpt-6-astra` and complete accounting. That smoke request is excluded from scoring.

The container executor mounts only the native session file read-only, uses an explicit synthetic profile and environment, and verifies expiry before each attempt. Host settings and credentials are not overwritten. The Linux ReleaseFast cross-build passed. See the README for live commands and containment evidence limits. New study results go outside the frozen input roots; historical evidence below is preserved.

## Implemented

- Reviewed compact builtin descriptions, with unchanged argument schemas, tool availability and permission filtering. The native footprint test measured 21,285 to 20,975 serialized bytes, a 310-byte reduction. This does not establish token or latency savings.
- One conditional verification continuation through the existing Stop mechanism. Recorded native mutations invalidate previous check evidence. Unrelated passing checks do not erase failed-check identities. Unsupported checks and asynchronous shell verification remain unknown. A passing recognized command does not prove task correctness.
- Bounded recorded task evidence in compaction and interrupted-task handoffs, including unresolved check identities and explicit omission counts. Exact durable execution records remain authoritative. Handoff data grants no permissions.
- Optional child concurrency and shared parent/child request and token admission limits, including retries, compaction and Vision model requests. Unknown usage blocks subsequent token-limited calls. One admitted request can overshoot the remaining allowance. Budgets are execution-window limits, not durable billing caps across host recreation. File ownership remains advisory, and children cannot spawn nested children.
- Unique request identities, request-purpose tags and explicit missing-versus-zero usage. Anthropic raw uncached/read/write counters are preserved; new accounting and budget settlement normalize total input once, with missing components or overflow remaining unknown. Existing raw usage/billing records are not rewritten.
- A separate reproducible study coordinator, strict accounting, immutable input manifests, protected journals, fixed one-control ablations, per-task regression gates, offline recovery tests, and a fail-closed executor entry point. The six legacy tasks, verifiers, scoring and saved results are unchanged.

## Builds

Commands ran from the repository root with Zig 0.16.0:

```
/opt/homebrew/bin/zig build -Doptimize=ReleaseFast --prefix /private/tmp/handwork-orchestrator.Goe3j6/baseline
/opt/homebrew/bin/zig build -Doptimize=ReleaseFast --prefix /private/tmp/handwork-orchestrator.Goe3j6/instrumented
```

Both builds passed, exit 0.

- Original reference SHA-256: `88e2dc2fb48d41825f6b9e21410e68cdd1017b94dd0dbf602b3e48bdda5b418e`.
- Instrumented SHA-256: `aed84d4ffefe600f1f14d655b2f80a621bec9cfe9e8fb6338f955116bd47a425`.

New comparisons must use the instrumented binary in both arms, with baseline controls absent and exactly one candidate control enabled. The original binary is reference-only because it lacks uniform accounting. These temporary artifacts are local, not released or installed production artifacts.

## Passing checks

```
python3 -B -m unittest discover -s benchmarks/orchestration-study -p 'test_*.py' -v
```

47 tests passed, exit 0. These include executor fixture reconstruction against all six frozen task contracts, strict accounting and purpose matching, drift detection, journal preservation, and trusted-fixture process-group cleanup. They are not evidence of model-backed recovery performance or containment of arbitrary detached descendants.

Each command below passed, exit 0:

```
/opt/homebrew/bin/zig build test -Dtest-filter='request accounting'
/opt/homebrew/bin/zig build test -Dtest-filter='execution budget'
/opt/homebrew/bin/zig build test -Dtest-filter='completion verification'
/opt/homebrew/bin/zig build test -Dtest-filter='public API'
/opt/homebrew/bin/zig build test -Dtest-filter='subagent late owner capacity rejection'
/opt/homebrew/bin/zig build test -Dtest-filter='subagent configured budget'
/opt/homebrew/bin/zig build test -Dtest-filter='subagent child capacity'
/opt/homebrew/bin/zig build test -Dtest-filter='subagent cap rejects'
/opt/homebrew/bin/zig build test -Dtest-filter='managed owner child cap'
/opt/homebrew/bin/zig build test -Dtest-filter='managed owner cancellation join'
/opt/homebrew/bin/zig build test -Dtest-filter='compaction'
/opt/homebrew/bin/zig build test -Dtest-filter='completion experiments'
/opt/homebrew/bin/zig build test -Dtest-filter='bounded delegation'
/opt/homebrew/bin/zig build test -Dtest-filter='compact schema'
```

Coverage includes owned-result exactly-once cleanup after missing provider admission, shared root/child admission, ambiguous-delivery settlement, cached-heavy Anthropic input normalization, and assembled root/child Vision tool budget and trace-identity forwarding. Formatting and `git diff --check` passed, exit 0.

## Unresolved broader checks

- `zig build test -Dtest-filter='subagent'` passed 128 tests and crashed in `ACP new and loaded sessions provide a writable subagent host` at `src/acp/sessions.zig:2900`, where `.select(.codex).?` unwraps null. The isolated command with that full test name also crashed in reconstructed pre-change source, exit 1.
- `zig build test -Dtest-filter='common Stop'` passed 39 tests and failed `common Stop parallel cancellation preserves ordinary cancelled peer as completed failure`, expecting three executed calls and observing two. That exact isolated test also failed in reconstructed pre-change source, exit 1.
- `zig build test -Dtest-filter='vision runtime'` passed 20 tests and failed six existing success/parser/bounds scenarios. The same six scenarios failed against reconstructed pre-change source, exit 1.
- Unfiltered `zig build test` was stopped after a stack sample showed the xAI deadline test joining a fixture thread blocked in `accept`. The full run is incomplete, with no successful exit code. This hang has not been reproduced against baseline and is not asserted to be pre-existing.

The diagnostic baseline tree was reconstructed from the original HEAD plus the saved pre-existing working-tree diff and unchanged untracked auth source, at `/private/tmp/handwork-orchestrator.Goe3j6/baseline-source`. No fix to these existing failures is claimed. The full repository suite is not green. All user-owned tracked edits and the pre-existing untracked auth source matched their initial snapshots after this work.

## Original live evaluation boundary (before container executor)

`executor.py` currently returns an inspectable blocker instead of starting a model-backed attempt. The frozen protocol does not establish a matching normalized execution environment, audited kernel descendant containment, or actual host-profile/private-verifier/sibling-workspace denial-probe evidence. Process-group cleanup alone does not contain a process that detaches. No host credentials or settings were staged or copied.

The Harbor preflight also found an unreachable Docker daemon, no active Harbor installation, and no validated matching Linux executable in the inspected output directories. No daemon was started, image pulled, dependencies installed, paid call made, or public suite executed.

Before scoring, establish and independently verify containment, freeze the execution environment and actual instruction/context inventory, and run the denial probes. A source manifest alone does not prove complete inherited personal-context control. Keep incomplete and failed attempts visible. The prospective native holdout still needs frozen fixture implementations and independent oracles; synthetic collector tests do not replace it.
