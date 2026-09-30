# Local provider stream processing

This benchmark measures Handwork's SSE framing and Responses event reduction, without a model, credentials, or network requests. It measures processing capacity, not provider tokens per second, terminal paint time, or overall task completion time.

```sh
zig build run-bench-provider-stream -Doptimize=ReleaseFast
```

Each case processes 40,000 text deltas containing an escaped Unicode character, followed by a terminal response. It verifies event counts, payload sizes, callback delivery, captured text, and completion metadata. Cases cover LF and CRLF framing, 256 KiB read buffers, and deliberately fragmented 17-byte reads. Capture is capped at 4 KiB. Each reported duration is the median of seven batches after a warmup; fixture creation and final cleanup are outside the timed region.

For a comparison, build baseline and candidate executables with the same compiler and optimization into separate prefixes, then alternate which executable runs first. Compare matching cases using total median time or events per second. `ns_per_event` is rounded down; use `median_ns` for ratios. Do not run builds or other benchmarks during timed comparisons.

The changes borrow complete single-data-line events directly from the transport buffer and parse small Responses events with 4 KiB of temporary scratch. Fragmented and multiline SSE events retain owned assembly. Large or complex JSON events retain heap parsing and release that storage after the event. The service tier, model, prompt, token accounting, event validation, and presentation behavior are unchanged.

Validation commands:

```sh
zig test src/provider/sse.zig
zig build test -Dtest-filter=Responses -Doptimize=ReleaseSafe
zig build test -Dtest-filter='OpenAI Codex' -Doptimize=ReleaseSafe
python3 tests/e2e/api-providers.py
```

Raw paired measurements and executable hashes are stored in `results.json`. They are synthetic local processing results, not evidence of a corresponding increase in model generation speed.

On macOS arm64 with Zig 0.16.0 and ReleaseFast, five alternating baseline/candidate pairs gave these medians for framing plus reduction:

| Framing | Read buffer | Baseline ns/event | Candidate ns/event | Local throughput increase |
| --- | --- | ---: | ---: | ---: |
| LF | 256 KiB | 490.2 | 357.1 | 37.3% |
| CRLF | 256 KiB | 495.5 | 356.6 | 38.9% |
| LF | 17 bytes | 637.2 | 489.0 | 30.3% |
| CRLF | 17 bytes | 640.1 | 496.8 | 28.8% |

Framing alone improved by 9–12% with the large buffer, was essentially unchanged for fragmented LF, and was 2.7% slower for fragmented CRLF. The combined processing path improved in all four cases. Absolute savings are about 0.13–0.15 microseconds per event in this fixture; a stream that already keeps up with the server may have no visible speed increase.

The focused checks passed: 11 framing tests, 94 tests in the Responses build, 30 tests in the Codex build, and six native provider integration tests. The build totals include one existing benchmark policy test each.

Broader validation has two baseline blockers on this machine. The `provider.` test selection stalls in the Grok deadline fixture's listener teardown; an isolated baseline test also exceeded a 55-second timeout. The WebAssembly core build fails at `src/core/auth/api_key_store.zig:23` because `FileNotFound` is not in the inferred error set. The same error reproduced in a clean export of baseline commit `28019d7cbd52ffb6c8d47213fce4be25dc7a9214`. Neither broader check is reported as passing.
