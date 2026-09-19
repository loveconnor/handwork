# Handwork tool batching: paired benchmark

Model: gpt-6-astra; reasoning: low; native Handwork; ReleaseFast. Fresh isolated workspaces, alternating baseline/optimized order, three fixtures. Both binaries include the same pre-existing workspace changes.

This experiment measures multi-file reads, multi-pattern literal search, overlapping search-context deduplication, and replacement prompt/tool descriptions. Independent actions, including edits to different files, can share a model response; mutations still use the existing per-file tool and approval path. This experiment does not include a cross-file mutation tool or a code execution runtime.

| Task | Success baseline → optimized | Mean calls | Mean input tokens | Mean output tokens | Median successful seconds |
|---|---:|---:|---:|---:|---:|
| pagination | 3/3 → 3/3 | 9.3 → 5.7 | 38,204 → 33,597 | 509 → 496 | 29.3 → 28.1 |
| search | 3/3 → 3/3 | 11.0 → 7.7 | 43,164 → 45,515 | 1,072 → 1,078 | 45.8 → 47.2 |
| tenant-cache | 3/3 → 3/3 | 25.3 → 9.3 | 77,705 → 67,587 | 2,143 → 2,036 | 82.9 → 79.6 |

Equal-weight aggregate across all attempts: tool_calls -50.4%, input_tokens -7.8%, output_tokens -3.1%, model_requests -6.6%. Task-level token regressions remain failures even when the aggregate improves.

| Task | Mean model requests | Mean native operations, expanding read batches | Median peak harness MiB |
|---|---:|---:|---:|
| pagination | 6.0 → 5.3 | 9.3 → 7.3 | 24.6 → 23.1 |
| search | 6.0 → 6.3 | 11.0 → 12.0 | 25.5 → 25.1 |
| tenant-cache | 8.3 → 7.3 | 25.3 → 25.3 | 30.3 → 27.5 |

## Acceptance checks

Input and output are separate constraints; lower combined cost does not compensate for increasing either. Token means include every attempt, including failures. Cached input remains input; reasoning output is not subtracted.

- pagination: correctness_pass=True, calls_lower=True, input_no_increase=True, output_no_increase=True
- search: correctness_pass=True, calls_lower=True, input_no_increase=False, output_no_increase=False
- tenant-cache: correctness_pass=True, calls_lower=True, input_no_increase=True, output_no_increase=True

## Interpretation and limits

Native tool-call counts include one call for a batch. Underlying file reads are separately expanded from batch diagnostics in `native_operations_excluding_shell_contents`; shell commands can still contain multiple operations. `model_requests` counts provider-admission trace events, so fewer tool calls must not be equated with the same reduction in inference round trips.

This is a small paired pilot, not evidence of a general quality or latency guarantee. The benchmark settings, user prompt, verifier, compiler optimization and model are fixed within each pair. Existing tests and private behavior checks must both pass. The tenant-cache verifier was reconstructed because the original temporary verifier no longer exists; it is validated against a broken and a historical known-correct control. Historical benchmark numbers are not used as the baseline.

No builds or unit tests run concurrently with scored agent attempts. Raw outputs, stderr, memory samples, diffs, final source/test snapshots and per-attempt checks are retained. Credentials are staged only for execution and restored afterward.
