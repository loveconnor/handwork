# Native tool batching experiment

The objective is fewer native tool calls while preserving task correctness and not increasing input tokens or output tokens independently. This is a paired pilot, not a general quality guarantee.

## Final result

The revised candidate passed all 18 correctness attempts. Across the equally weighted task mix, native tool calls fell 50.4%, input tokens fell 7.8%, and output tokens fell 3.1%. Pagination and tenant-cache met both token constraints. Search reduced calls by 30.3% but increased input 5.4% and output 0.5%; therefore the strict per-task objective is not fully met.

Search had an additional model request in one optimized attempt, and its expanded underlying operation count averaged 12 versus 11. This suggests the next useful experiment is reducing repeated exploration and schema/context overhead, rather than merely packaging more operations into one call. The small sample does not establish a causal explanation or general guarantee.

See [the final report](results-final-2026-09-18/REPORT.md) for per-task counts, token use, latency, memory, acceptance checks and raw evidence. The initial failed candidate is retained separately; it is not pooled into the final comparison.

## Changes

- `read_file` accepts either the existing path/range or `files`, an array of up to 32 path/range objects. One shared result budget bounds the batch. Exact duplicate requests are skipped. File snapshots reuse scratch storage instead of accumulating in the turn allocator.
- Permission admission and live authority evaluate every requested path. Session grants and approval labels include the batch targets.
- Per-file memory evidence records only successful, disclosed reads, retaining full-file versus partial-file coverage. Truncated results do not claim trusted batch coverage.
- `grep_files` accepts either one literal `pattern` or up to 32 literal `patterns`. The native backend scans the union once, with the same behavior in the fallback. Matching lines and overlapping context are deduplicated.
- Short tool descriptions and prompt guidance encourage bounded batch reads/searches and grouping independent actions in one model response. Editing retains the existing per-file mutation, approval and durable commit mechanism.

## Evaluation

The baseline was built before these changes, with the user's pre-existing workspace edits. Both variants use frozen ReleaseFast binaries, the same model/effort, identical task prompts, fresh isolated fixtures, alternating execution order, existing tests and private behavior checks. Broken and known-correct controls validate each verifier. The tenant-cache verifier was reconstructed because the historical temporary verifier no longer exists.

Three tasks, three attempts per variant per task: pagination, asynchronous search and tenant-cache authorization/invalidation. All attempts count toward token means. Cached input is still input; reasoning output is not removed. Native tool calls, expanded batch file operations, model requests, time and peak process memory are recorded separately. Fewer native calls do not necessarily mean fewer model round trips or less underlying work.

No compilation or unit-test runs overlap scored attempts. The harness restores the original Handwork authentication/settings after each attempt. Credentials are not retained in benchmark artifacts.

## Artifacts

- `results-2026-09-18/`: first candidate. All 18 attempts passed correctness; calls and output fell, but input rose on every task. This candidate failed the token constraint.
- `results-final-2026-09-18/`: revised candidate, restoring explicit grouping of independent actions and adding durable per-file batch evidence and snapshot storage reuse.
- `source-snapshots/`: first candidate, baseline and common pre-existing source edits, with hashes.
- `source-final/` and `implementation-final.diff`: exact final candidate sources and diff.
- `verification.json`: final read-file tests, multi-pattern search tests, prompt tests and release build results. A broader earlier `batch` test selection also encountered two vision runtime failures; a clean full-suite result is not claimed.

Generate a report after the runner completes:

```sh
python3 benchmarks/tool-batching/report.py benchmarks/tool-batching/results-final-2026-09-18
```

Run a new experiment (use a new output directory):

```sh
python3 benchmarks/tool-batching/run.py \
  --baseline /tmp/handwork-batching-baseline/bin/handwork \
  --optimized /tmp/handwork-batching-final/bin/handwork \
  --out benchmarks/tool-batching/results-new \
  --attempts 3
```
