# Handwork tool batching: paired benchmark

Model: gpt-6-astra; reasoning: low; native Handwork; ReleaseFast. Fresh isolated workspaces, alternating baseline/optimized order, three fixtures. Both binaries include the same pre-existing workspace changes.

This experiment measures multi-file reads, multi-pattern literal search, overlapping search-context deduplication, and replacement prompt/tool descriptions. It does not include cross-file edit batching or a code execution runtime.

| Task | Success baseline → optimized | Mean calls | Mean input tokens | Mean output tokens | Median successful seconds |
|---|---:|---:|---:|---:|---:|
| pagination | 3/3 → 3/3 | 9.0 → 5.0 | 33,941 → 37,201 | 519 → 483 | 28.8 → 27.2 |
| search | 3/3 → 3/3 | 11.0 → 5.3 | 43,180 → 44,890 | 1,069 → 1,023 | 43.4 → 43.8 |
| tenant-cache | 3/3 → 3/3 | 25.0 → 8.7 | 77,993 → 90,255 | 2,293 → 2,027 | 91.6 → 82.3 |

## Acceptance checks

Input and output are separate constraints; lower combined cost does not compensate for increasing either. Token means include every attempt, including failures. Cached input remains input; reasoning output is not subtracted.

- pagination: correctness_pass=True, calls_lower=True, input_no_increase=False, output_no_increase=True
- search: correctness_pass=True, calls_lower=True, input_no_increase=False, output_no_increase=True
- tenant-cache: correctness_pass=True, calls_lower=True, input_no_increase=False, output_no_increase=True

## Interpretation and limits

Native tool-call counts include one call for a batch. Underlying file reads are separately expanded from batch diagnostics in `native_operations_excluding_shell_contents`; shell commands can still contain multiple operations. `model_requests` counts provider-admission trace events, so fewer tool calls must not be equated with the same reduction in inference round trips.

This is a small paired pilot, not evidence of a general quality or latency guarantee. The benchmark settings, user prompt, verifier, compiler optimization and model are fixed within each pair. Existing tests and private behavior checks must both pass. The tenant-cache verifier was reconstructed because the original temporary verifier no longer exists; it is validated against a broken and a historical known-correct control. Historical benchmark numbers are not used as the baseline.

No builds or unit tests run concurrently with scored agent attempts. Raw outputs, stderr, memory samples, diffs, final source/test snapshots and per-attempt checks are retained. Credentials are staged only for execution and restored afterward.
