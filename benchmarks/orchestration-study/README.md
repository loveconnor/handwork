# Orchestration study

This is a separate descriptive pilot, not a significance test or public benchmark score. It does not change the six legacy tasks, their verifiers, scoring, historical results, or historical 20% target.

Bounded delegation is now enabled by default in Handwork at the user’s request. `HANDWORK_EXPERIMENT_BOUNDED_DELEGATION=0` restores the original behavior; `=1` remains supported. Other experiments remain opt-in. This rollout does not claim that every benchmark promotion gate passed.

Future freezes use protocol version 2: the executor pins bounded delegation to `0` in the common environment before applying the selected arm’s controls. A bounded-delegation candidate overrides it with `1`; other feature studies retain `0` in both arms. The common environment is hashed in the executor configuration. Historical manifests, source snapshots and results keep their original protocol and are preserved.

## Scope and execution boundary

`run.py` is an offline coordinator and external-execution collector. It freezes inputs, schedules attempts, records starts before execution, reconciles traces, retains outcomes, and evaluates promotion. It never launches Handwork, copies credentials, reads host authentication, stages settings, installs dependencies, or invokes `pilot.handwork_auth`. `container_executor.py` supplies the separate live Docker execution path described below. The old `executor.py` entry point remains a fail-closed inspector for manifests without a container backend.

The parent owns builds and live execution. The container executor uses the native configured login with enforced host-profile write denial. A login expiring within the attempt budget blocks execution. Credentials are never copied or refreshed by the runner. The existing legacy context manager overwrites both host auth and settings and is prohibited. Isolated configuration preserves the frozen legacy model, effort, and task behavior. No provider/model substitution is permitted.

## Container execution

Requirements: a reachable local Linux Docker engine, an immutable local image ID providing Node 24+, Python 3 and Git, a matching Linux Handwork binary, and a valid native `~/.handwork/chatgpt-auth.json` login. Build and pull images before freezing or starting attempts. Example for an ARM Mac:

```sh
zig build -Dtarget=aarch64-linux-musl -Doptimize=ReleaseFast --prefix /absolute/build-directory
docker pull node:24-bookworm
docker image inspect node:24-bookworm --format '{{.Id}}'
HANDWORK_DOCKER_TEST_IMAGE=sha256:<image-id> HANDWORK_NATIVE_TEST_BINARY=/absolute/build-directory/bin/handwork python3 -B -m unittest discover -s benchmarks/orchestration-study -p 'test_*.py' -v
python3 -B benchmarks/orchestration-study/container_executor.py prepare /absolute/new-study --binary /absolute/build-directory/bin/handwork --image sha256:<image-id> --feature COMPACT_SCHEMAS
python3 -B benchmarks/orchestration-study/container_executor.py run /absolute/new-study --all
python3 -B benchmarks/orchestration-study/run.py report /absolute/new-study
```

Run separate studies for `VERIFY_COMPLETION`, `TASK_EVIDENCE`, and `BOUNDED_DELEGATION`. The numeric budget controls still require explicit chosen values and are not silently added to these comparisons. Results belong outside `benchmarks/orchestration-study` and all other hashed input roots. Do not edit frozen source or documentation during runs. Keep the image ID, environment, synthetic settings, engine/kernel version, binary hash and source inventory in each manifest.

The bounded-delegation comparison enables session storage in the container's temporary profile in **both** arms. Native `--no-save` disables the subagent host and removes its tool; earlier no-save comparisons did not exercise bounded delegation and their per-task differences cannot be attributed to it. These original results remain preserved. Other comparisons retain no-save execution. The synthetic profile disables model-generated session titles to prevent auxiliary calls to a different model. Each new manifest freezes the session policy. Bounded-delegation records require root activation evidence showing the tool available in both arms and a configured child policy only in the candidate. Delivered root guidance must remain zero in both arms. Actual child requests are reported separately; tool availability alone does not prove delegation occurred.

Bounded mode uses compact operating policies for parent and child turns only when the host supplied the exact built-in system prompt. It preserves the default identity, evidence, workspace authority, permission and communication sections byte-for-byte. Custom host prompts and named-child overlays are never rewritten; additional host instructions, skills, user messages, model overlays, tool availability, schemas and permissions remain unchanged. The baseline keeps the full default operating policy. This is an intentional extension beyond the earlier child-only profile: nondelegating tasks now exercise a real parent-policy difference instead of comparing identical model-visible inputs.

The parent policy explicitly batches independent edits to different files, batches inspection, requires localized edit_file patches instead of unchanged-code rewrites, and groups existing tests, uncovered edge probes and final diff checks in one shell.run with failure-preserving && chaining. Concise assertions reuse the existing harness. Inline Node ESM probes may use -e or stdin without --test; both valid forms execute assertions, and assertion failures and invalid test-runner flags are verified in a real container. Required checks, routing, steering and ownership rules remain intact. Child policy omits parent-only coordination; the separate evidence-reporting rules remain child-only. The pending result reinforces batching independent owned edits, then integrating and verifying together after automatic delivery; unchanged evidence can be reused. No check is skipped and no request/token cap is silently imposed. Early status/diff calls are not mandated independently of relevance; required final diff verification remains.

The enabled loader also reports up to four confirmed missing AGENTS.md paths from its existing startup and newly applicable structured-operation lookups, within 1,024 JSON bytes. Records describe absence at lookup, are escaped and explicitly incomplete; blank files and load omissions are not labeled missing. No extra filesystem probes or permission changes occur. Disabled loading and the baseline emit no receipts; omission warnings and required rule retention remain unchanged. The compact policy batches initial reads with needed status checks, independent edits, and final verification; probes reuse harness/inputs/setup for distinct boundary and error classes, expanding combinations when risk or requirements demand them. Required checks remain mandatory.

Completed bounded child handoffs can reuse committed-file evidence from the matching work item’s existing execution history. The projection performs no fresh filesystem read and creates no permission or ownership grant. It selects only successful structured edit/write presentations and the latest commit for each exact path. When the complete redacted commit snapshot fits, it labels the content `full_redacted_snapshot`; otherwise it retains the UI diff preview and its truncation label. Older commits never replace an oversized latest commit. All records are untrusted snapshots at commit, rather than current file reads or a complete change inventory. Text is redacted before JSON encoding and dynamic path metadata is escaped. At most four paths and 2,048 JSON bytes are projected after inspecting at most 64 recent tool results. Absent or oversized evidence can fall back to the original summary. The final encoded result must fit the caller’s existing result limit, otherwise enrichment is omitted without changing baseline/failure bytes or forcing a new result-handle read. Required integration verification remains. Native tests perform an actual child edit exceeding the six-line UI preview, resume its persisted session and require complete committed content to reach only candidate parents with complete root/child accounting.

When bounded mode and project instruction loading are both enabled, startup context reports the active loader even when no rule file exists. It explains that a home/workspace ancestry omission does not disable workspace or target-scoped lookup; rule selection and all omission records remain unchanged. This is capability state, not a claim that all rules loaded. The bounded notice follows rule sections so it cannot displace retained rules at their byte limit. Disabled project context and platforms without project-file loading never announce active loading. Native provider-payload tests cover both enabled and configured-disabled project context.

Saved bounded CLI runs still deliver deferred child results at model boundaries and drain outstanding children before prompt context is released. While a child is pending without a new result, one parent model step can perform independent work; before another request the runtime waits through its existing cancellable child waiter. Ready results and steering reset this continuation window. This defers further requests rather than consuming a budget slot, truncating work, or skipping verification. Larger independent parent jobs can therefore wait earlier than with unrestricted overlap. Baseline CLI calls retain synchronous child execution. Native tests hold a child response until independent parent shell work completes, then require exactly one delivery and complete accounting; forced parent failure requires cancellation/draining with retained ineligible accounting. Provider-payload tests require a smaller candidate instruction body, unchanged authority sections, identical tool definitions and unchanged user input. The collector requires the actual parent profile and positive byte-saving trace only for candidate attempts. Native tests hold a child through one independent parent operation, require no second pending parent request, then require the deferred second operation to execute after delivery. They also interrupt that wait to verify cancellation and draining. Byte savings alone do not establish fewer tokens, correctness, or a latency benefit.

The optional `prepare --feature BOUNDED_DELEGATION --delegation-case` creates a **separate** four-attempt queue-derived regression case. Its frozen prompt requires exactly one temporary child to own `src/map.js` while the parent owns `src/worker.js`, then integrates and verifies. Both arms use the same prompt, queue fixture, private verifier, session capability, budgets and isolation checks. The case requires exactly one admitted child identity, correct child policy delivery, and complete reconciled parent/child accounting. It runs baseline/candidate then candidate/baseline. Its manifest and report are separate from the unchanged six-task schedule and denominator. It is regression coverage, not a fresh holdout. All original correctness, input/output and time gates still apply; no speedup is inferred from an A/A fluctuation in the six nondelegating tasks.

Each attempt gets its own container PID namespace, read-only root filesystem, dropped capabilities, no privilege escalation, process/memory/CPU limits, and fresh temporary profile and scratch space. Only its workspace is a writable host mount. Disposable sessions remain in profile tmpfs and disappear with container removal. The existing native login is a read-only file mount. `HANDWORK_AUTH_READ_ONLY=1` also prevents remote refresh-token rotation: stored credentials must be current, and forced refresh fails before contacting the token endpoint. A declared synthetic profile selects `gpt-6-astra`, low effort and the native subscription, without inheriting host settings, skills, instructions, environment secrets or sessions. Private verifiers and sibling workspaces are never mounted in the model container. The Docker socket is never mounted. Provider calls need outbound networking; this implementation does not claim endpoint-restricted egress or protection against kernel/engine vulnerabilities.

The host's numeric UID/GID stays in use for workspace ownership. A generated read-only `/etc/passwd` supplies that UID with the synthetic home `/profile` and `/bin/bash`; it contains no host account data or passwords. Its contents are frozen in the executor configuration and retained with each container invocation. Native shell resolution uses `getpwuid`, so an environment-only `$SHELL` does not fix a missing image account. Earlier runs without this mapping forced `MissingLoginShell` repairs and TTY workarounds; their usage remains recorded, but cannot establish performance in the corrected environment. Native integration tests require a shell command to complete directly in both arms without repair calls or polling. Preflight probes verify identity lookup and write denial before each model attempt.

Before every model attempt, actual read/write denial and detached-descendant probes must pass, and the private oracle must reject the broken fixture and accept the legacy known-correct control. The model container is force-removed and its absence checked before verification or another attempt. Verifiers run separately with no login and no network. A lock prevents overlapping invocations of this executor. The measured duration includes container startup and teardown, including descendant termination; fixture preparation and oracle checks are outside the measurement.

Container probes and tests provide bounded evidence for these controls; they are not an independent security audit. Native smoke calls are diagnostic and excluded from scored attempts. Failures, interrupted starts and raw logs are retained. Missing or inconsistent request accounting stops a study. Tests with `HANDWORK_DOCKER_TEST_IMAGE` exercise the real engine with synthetic non-secret credentials and retain their evidence in a printed temporary directory.

Provider recovery preserves nested subscription error objects and their `type` classification when `code` is null. Known `server_error`, `server_is_overloaded`, and rate-limit errors can enter the existing bounded recovery policy; unknown and request-rejection errors remain non-retryable. A live diagnostic comparison exposed `server_is_overloaded` after the old parser had hidden the nested error behind a generic message. An assembled native-container test verifies recovery from this overload classification, while retaining both request records and unknown usage on the failed call. Recovery does not establish missing token counts. The [Responses streaming event reference](https://developers.openai.com/api/reference/resources/responses/streaming-events) also shows that failed responses can have null usage. Prior studies and failures are retained when new source and binaries require a fresh comparison directory.

The collector accepts an external executor's attestation. It does not independently rerun behavioral verifiers or prove that the executor enforced isolation. An attestation alone is not independent evidence of runtime safety. Preserve the executor's verifier outputs, sandbox policy and denial probes, environment/context verification, and immutable logs alongside the study. Do not publish a promotion claim until those artifacts have independent review.

## Frozen protocol

- Two pairs for each of pagination, search, tenant-cache, queue, ledger, stream. All six are now regression coverage. The old queue/ledger/stream holdout is no longer fresh.
- Model `gpt-6-astra`, effort `low`, 600 seconds per attempt. Fresh workspace and session per attempt. Serial, counterbalanced baseline/candidate order. No builds or other benchmark workloads overlap attempts.
- Both arms use the SAME fresh post-instrumentation executable hash. The original SHA-256 `88e2dc2fb48d41825f6b9e21410e68cdd1017b94dd0dbf602b3e48bdda5b418e` is reference-only because it lacks uniform request accounting.
- Both arms explicitly pin `HANDWORK_EXPERIMENT_BOUNDED_DELEGATION=0` as common environment policy before applying arm controls. Baseline has no varying controls. Candidate changes exactly one control: `COMPACT_SCHEMAS`, `VERIFY_COMPLETION`, `TASK_EVIDENCE`, `BOUNDED_DELEGATION`, `MAX_CHILDREN`, `MAX_REQUESTS`, or `MAX_TOKENS`, with that prefix. Budget controls require a positive integer. Each is its own study. For `BOUNDED_DELEGATION`, candidate `1` overrides the common `0`; all other candidates keep bounded mode off. No automatic planner routing or combined features.
- Identical trace configuration: `HANDWORK_TRACE_STDERR=1`, `HANDWORK_TRACE_SCOPES=agent,subagent`. Clear all inherited experiment and trace variables before applying the selected arm. `arm_env` constructs this environment but does not execute it.
- Every candidate attempt must be correct. Per task, neither all-attempt total input nor output may increase, and median successful time may not regress more than 5%. With equal repetition, total-token and mean-token comparisons are equivalent. Require at least 5% improvement in aggregate all-attempt time OR input. Incomplete/failed attempts and unavailable usage cannot pass. Baseline failures also block promotion rather than allowing a success-only comparison to hide them.
- Preserve every failure, timeout, cancellation, interruption, and diagnostic retry. Never replace a scheduled failure. Diagnostic reruns belong in another directory, not the promotion denominator. A changed protocol or source requires a new freeze and directory.

## Input integrity

The manifest hashes working-tree source, including untracked runtime code and tool schemas, build/package inputs, relevant benchmark generators, verifiers, fixtures, exact legacy task-contract snapshot, and this runner/tests/docs. It hashes the actual binary, configuration, and explicit instruction/skill files. HEAD is provenance, not proof of unchanged working contents. Symlinks in source inputs fail closed. Source-set changes, including added untracked files, invalidate verification.

The coordinator reads the legacy frozen task contracts as data, without executing legacy preparation/auth code. The external executor must reconstruct and check the recorded initial fixture hashes, exact prompt, and verifier hashes. Broken and known-correct controls remain required. Workspace rules about adding tenant-cache tests remain unchanged.

Never put credentials or secret-bearing settings/environment values in a context input or execution bundle. Explicit context inputs are instruction/skill Markdown files only. A dedicated instruction/profile-context inventory and its enforcement need independent review before live use. Unlisted inherited personal context makes the live comparison ineligible, not a pristine-profile experiment.

Study outputs must be outside the hashed source inputs, preferably a separate restricted directory. Hashes detect drift but are not signatures or protection against a malicious executor rewriting the entire evidence chain.

## Offline commands

From the repository root:

```
python3 -B -m unittest discover -s benchmarks/orchestration-study -p 'test_*.py' -v
python3 -B benchmarks/orchestration-study/run.py preflight
python3 -B benchmarks/orchestration-study/run.py freeze --binary /absolute/fresh/handwork --feature COMPACT_SCHEMAS --out /absolute/new-study
python3 -B benchmarks/orchestration-study/run.py verify /absolute/new-study
```

Repeat `--context-file /explicit/instruction.md` for every instruction/skill file made available to both arms. Freeze does not authorize model calls. The compiled binary's runtime support for each control must be independently verified by the parent; accepting a control name does not prove that it is implemented.

For each scheduled ID, in manifest order:

```
python3 -B benchmarks/orchestration-study/run.py start /absolute/new-study pagination-1-baseline
# Parent executor runs externally, preserving trace, native JSON, and verification evidence.
python3 -B benchmarks/orchestration-study/run.py record /absolute/new-study pagination-1-baseline --bundle /absolute/bundle.json --trace /absolute/trace.log --stdout /absolute/native.json
python3 -B benchmarks/orchestration-study/run.py report /absolute/new-study
```

Start records are exclusive and remain if execution never finishes. Record files are also exclusive. Invalid execution evidence is retained as a failed record. The collector snapshots supplied bundle, trace, and native output into exclusive per-attempt artifact directories with owner-only file permissions, then hashes them. Report rejects missing or changed snapshots. Malformed imports still retain their start and artifact directory and cannot be silently replaced. Report prints JSON to stdout, so collecting a report never overwrites old evidence. Exit codes: 0 accepted operation or promotable report, 1 failed record/non-promotable report, 2 blocked/invalid operation.

An execution bundle contains the following fields. Booleans must be actual JSON booleans, not strings. These fields attest external checks; they are not substitutes for the original check artifacts.

```
{
  "manifest_sha256": "<manifest digest>",
  "binary_sha256": "<same instrumented binary in both arms>",
  "task_contract_sha256": "<digest of configuration.tasks[task]>",
  "initial_fixture_hashes": {"<relative fixture path>": "<actual initial SHA-256>"},
  "verifier_sha256": "<actual verifier SHA-256>",
  "prompt_sha256": "<actual prompt UTF-8 SHA-256>",
  "trace": {"HANDWORK_TRACE_STDERR": "1", "HANDWORK_TRACE_SCOPES": "agent,subagent"},
  "controls": {},
  "duration_s": 100.0,
  "exit_code": 0,
  "timeout": false,
  "fresh_workspace": true,
  "fresh_session": true,
  "protected_files_unchanged": true,
  "no_dependencies": true,
  "existing_tests_pass": true,
  "private_checks_pass": true,
  "broken_control_rejected": true,
  "known_correct_control_passed": true,
  "host_profile_write_denied": true,
  "context_hashes_verified": true
}
```

The initial fixture map, verifier hash, and prompt hash must exactly match the frozen legacy task contract. Candidate `controls` must exactly equal the frozen candidate map. Baseline uses `{}`. Native JSON must show a completed final output with the exact model and successful exit. CLI usage is main-agent-only and is not added to trace counters.

## Accounting contract

Reconcile `request_attempt_started`, `provider_admitted`, and terminal `request_accounting` by process-wide request ID, not step or child ID. Require exactly one start and terminal per ID and exactly one admission iff terminal `admitted=true`. Aggregate only admitted requests. Root and child totals are disjoint diagnostics; their sum equals whole-process totals, including compaction stream invocations. A multi-process executor must namespace traces by process and reconcile each process separately before aggregation; concatenating separate process logs with reused IDs is rejected, not silently deduplicated.

Start and terminal records must both contain a matching `purpose=generation|compaction|image`. Purpose is independent of child identity. Missing, invalid, or changed purposes fail closed. `purpose_usage` reports admitted request counts and input/output/cached/uncached totals per purpose, per attempt and per arm/task, with an aggregate arm breakdown. A measured-zero request has count 1; an unused purpose has count 0. An ineligible attempt has unavailable purpose totals, never fabricated zero usage.

`input_known`, `output_known`, and `cache_known` must all be true. Placeholder zero with known=false is unavailable. Independently enforce cached <= input and consistent=true. Uncached = input - cached only after reconciliation. Failed/transport-failed, malformed, missing, duplicate, or inconsistent evidence makes the attempt ineligible. Unadmitted failures remain failures even though their placeholders never enter totals. A cancelled attempt before request-start emits no accounting and must fail the execution outcome check.

The accounting trace already normalizes provider context input. For Anthropic, upstream `totalContextInput` combines raw uncached input plus cache read/create counters exactly once, returning unknown on missing counters or overflow. OpenAI/Codex input is already total. The collector must NOT add cache counters to the trace input again or substitute legacy CLI usage; raw legacy CLI counters remain unchanged. The reported `uncached=input-cached` is the non-cache-read remainder and may include Anthropic cache creation, not just Anthropic's raw uncached input field.

These are context usage counters, not authoritative billing. Cache-read tokens are a subset of input, not additional input. Report cached/uncached separately; unknown provider-cache state is not a controlled cold cache. Do not pool deliberately warm/cold experiments. Do not sum overlapping child request durations into end-to-end time. Measure wall time through descendant completion/cancellation and retain retries within the same budget.

## Fresh holdout and recovery evidence

`heldout-protocol.json` declares a separate, unscored prospective holdout. It must not enter the fixed six-task denominator. The offline synthetic tests exercise collector recovery/accounting contracts, not actual native orchestration or model recovery. Fresh native fixture implementations, private oracles, independent review and hashes must be frozen before parent execution. No heldout runtime results are claimed here. Once any holdout result informs tuning, retire it to regression coverage and create another fresh holdout.

## Current readiness and tenant-cache evidence

See `EVIDENCE.md` for observations and causal limits. Compact descriptions currently save 310 schema bytes per the parent's check, not an established token or latency benefit. This study changes reviewed builtin descriptions only; schema structure, names, permissions, and tool availability must remain invariant. Parent owns native invariance tests and live validation. No public score is claimed.
