# Token-saving projection benchmark — September 13, 2026

## Scope

Offline A/B measurement of the previous and current production serialization and tool-result projection code. No model generations were made. This is **not** an end-to-end coding benchmark, a provider-token measurement, or a subscription allowance benchmark.

The official Codex adapter change adds usage reporting only; it does not change the official engine's prompts or tools. Running that engine before/after would not exercise the native preview optimizations. A read-only `account/rateLimits/read` probe succeeded with Codex CLI 0.147.0 and exposed quota consumption as a whole-number percentage; it supplies no per-request quota charge suitable for attributing these small changes. No account identifiers, balances, or credentials are saved here.

## Method

`run.py` copies the current source tree into an isolated temporary directory. For baseline it substitutes the saved pre-change `execution_memory.zig` and `api_protocol.zig`; for optimized it restores the current versions in that temporary copy. The working source tree is never swapped or reset. Source snapshots, SHA-256 hashes, logs, and the exact probe are retained with each successful report.

The same production-code probe runs for both variants under Zig 0.16.0. It produces 42 paired cases: six deterministic, repeated source-search lines sized to 4, 8, 12, 16, 32, and 64 KiB, through seven paths:

- Stored `grep_files`, `glob_files`, and unchanged `read_file` results.
- Unstored search results, an unchanged control.
- Required shell command replay, including its retrieval notice.
- Chat Completions text/image requests and unchanged Anthropic requests.

Stored results are read back and checked against their full input. Shell replay availability is checked. This measures text bytes after projection, including notices (or full serialized JSON for API cases). Token estimates use Handwork's whitespace/span estimator, **not** a provider tokenizer. Image token costs are excluded; the image is a serialization fixture, not an inference input. Output tokens, repeated retrievals, cache behavior, retries, task success, and future context replay are not measured.

## Results

Use `results-2026-09-13-v2/report.json`. Both production probes passed, exit 0, and all 42 pairs were recorded. Unchanged read-file, unstored-search, and Anthropic controls matched exactly. The initial `results-2026-09-13/` attempt failed because its fixture directory lacked the private permissions required by the result store; it has no scored results. The corrected fixture explicitly creates a 0700 session directory.

| Path / raw text | Before bytes | After bytes | Byte reduction | Estimated text-token reduction |
| --- | ---: | ---: | ---: | ---: |
| Shell / 4 KiB | 4,306 | 4,306 | 0% | 0% |
| Shell / 12 KiB | 12,498 | 8,141 | 34.86% | 34.77% |
| Shell / 32 KiB | 32,978 | 8,141 | 75.31% | 75.27% |
| Shell / 64 KiB | 65,485 | 8,141 | 87.57% | 87.55% |
| Stored search / 12 KiB | 12,288 | 4,457 | 63.73% | 63.58% |
| Stored search / 16 KiB | 16,384 | 4,457 | 72.80% | 72.68% |
| Stored search / 32–64 KiB | 4,457 | 4,457 | 0% | 0% |
| Chat text/image request / 12 KiB text | 25,326 | 12,837 | 49.31% | 49.33% |

Stored glob results match the search behavior. Large stored results already used approximately 4 KiB previews before this change, so there is no blanket 64-to-8 KiB saving across tools. Small tasks can see no preview reduction. Additional retrievals can offset savings. Do not average these synthetic cases into a claimed workload or subscription percentage.

## Reproduce

From the repository root, choose a new output directory (the runner refuses overwrites):

```sh
python3 benchmarks/token-savings/run.py \
  --zig /tmp/zig-aarch64-macos-0.16.0/zig \
  --baseline-memory benchmarks/token-savings/results-2026-09-13-v2/baseline/src/core/agent/runtime/execution_memory.zig \
  --baseline-api benchmarks/token-savings/results-2026-09-13-v2/baseline/src/provider/api_protocol.zig \
  --output benchmarks/token-savings/results-new
```

Formatting check: `/tmp/zig-aarch64-macos-0.16.0/zig fmt --check benchmarks/token-savings/probe.zig`.

Actual subscription savings remain unknown. A later end-to-end native-loop study should freeze these exact variants, alternate identical verified tasks, count all model calls and retrievals, and record input/cache/output/reasoning usage alongside quota snapshots. It must use an authorized provider route and report quota resolution, resets, and concurrent account usage rather than converting text savings directly into extra subscription lifetime.
