# Local evidence and limits

Read-only investigation on October 18, 2026. No new model-backed attempt, build, container run, dependency installation, or host auth/settings change was made by this study's author.

## Tenant-cache regression investigation

Sources are `../harness-efficiency/results-final/attempts.json`, the four `tenant-cache-{1,2}-{baseline,optimized}.stdout` and `.stderr` files, and the old paired report. Their two-pair summaries are descriptive only.

| Measure | Baseline | Candidate |
|---|---:|---:|
| Mean seconds | 80.4245 | 90.777 |
| Mean total input | 70,946 | 82,053.5 |
| Mean output | 2,021.5 | 2,290.5 |
| Mean cached input | 18,240 | 17,728 |
| Mean uncached input | 52,706 | 64,325.5 |

The uncached calculation is total input minus cached input, not total plus cache. These old counters and main-agent CLI summaries are historical evidence, not a replacement for new whole-process accounting.

Pair 1 took 77.774 baseline versus 97.963 candidate seconds. Candidate made nine requests versus seven and used 97,842 versus 63,501 input tokens. It issued two failed Git diagnostic commands after writing an added isolation test. One tried `git show HEAD:tests/organization-isolation.test.ts` for a file not tracked in HEAD. Another compound command ended with `git check-ignore`, whose nonzero exit does not itself mean the preceding tests failed. These extra diagnostic rounds are an observed mechanism for extra context replay and requests in this attempt, not proof that any particular runtime feature caused them.

Pair 2 took 83.075 baseline versus 83.591 candidate seconds. Candidate made seven requests versus nine, with 66,265 versus 78,391 input tokens. Both passed the existing/private task checks in the archived records. This pair contradicts a claim that the candidate consistently adds requests or input on tenant-cache.

Candidate request-finished elapsed intervals summed to 96.438 seconds of 97.963 wall seconds for pair 1, and 82.472 of 83.591 for pair 2. The longest individual intervals were 44.390 and 41.764 seconds. This shows that most observed candidate wall time lies within provider invocation intervals. It does not isolate inference, provider queueing, network latency, or local request work, and baseline lacks the same detailed events. Do not infer a traced-overhead effect from these sums.

Duplicate-result projection savings and repeated-failure hints were zero in both candidate attempts. Therefore those mechanisms were not observed firing in these traces. Absence of firing is not proof that their surrounding code has no overhead or behavioral effect.

Candidate-only detailed tracing, inherited personal context, provider-cache variability, generated patch/test differences, and model/network nondeterminism remain confounders. The two pairs cannot establish causation. The new study uses a common instrumented binary, identical trace configuration, one-control ablations, explicit cache splits, and predeclared per-task gates to test these hypotheses rather than claim the cause is known.

## Harbor readiness

Observed through the user shell PATH: Zig 0.16.0 and Docker CLI 28.5.2 are available. `docker info --format '{{.ServerVersion}} {{.Architecture}} {{.OSType}}'` exited 1 because the configured local Docker daemon socket was unreachable. Harbor was absent from the active CLI PATH and `/usr/bin/python3` distribution metadata. The clean shell PATH omits several tools, so its absence checks alone were not used as machine-wide evidence.

Inspected `zig-out/bin` and `prebuilds` artifacts were macOS Mach-O, Windows PE, or WebAssembly, not a Linux ELF Handwork executable. This is a bounded search of likely output directories, not proof no ELF exists anywhere on the machine. A pinned Harbor installation, reachable container engine, reviewed task image/architecture, and tested matching Linux binary remain prerequisites. No Docker daemon was started, no image was pulled, and no Harbor smoke or public suite was executed.

The original frozen baseline at `/private/tmp/handwork-orchestrator.Goe3j6/baseline/bin/handwork` matched SHA-256 `88e2dc2fb48d41825f6b9e21410e68cdd1017b94dd0dbf602b3e48bdda5b418e` during inspection. It is reference-only. New comparisons must use the same fresh accounting-enabled binary in both arms.

Parent feedback reports compact builtin descriptions reduce serialized footprint from 21,285 to 20,975 bytes, a 310-byte change. This author did not run the native tests or a live comparison. Byte savings are neither token savings nor evidence of improved completion time.
