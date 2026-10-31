# On-demand tool loading pilot — October 31, 2026

The native runtime now advertises `read_file` and `load_tools` at the start of a clean coding conversation. The loader lists every eligible deferred built-in by exact name. Selecting tools adds their existing definitions to subsequent requests; the tool implementations, argument validation and permission checks remain in place. Selection is atomic, repeated selections are idempotent, and retained tool-call history restores selections on resume. Following history compaction, definitions can be loaded again. Custom host functions, provider-native tools and selected MCP definitions retain their existing advertisement paths. Disabling or omitting the loader falls back to eager advertisement.

Use `HANDWORK_ON_DEMAND_TOOLS=0` for the eager baseline. The same binary was used for both arms. The earlier compact-description change was enabled in both.

## Measurements

| Measure | Eager | On demand |
| --- | ---: | ---: |
| Final clean startup, local token estimate | 5,369 | 1,584 |
| Live tokens, including automatic safety reviews | 82,879 | 51,851 |
| Main-agent tokens only | 74,484 | 44,151 |
| Combined elapsed time for three tasks | 52.897 s | 54.884 s |
| Median task time | 20.759 s | 21.101 s |
| Independently verified tasks | 3/3 | 3/3 |

Final startup context fell **70.50%**. The live session-ledger total fell **37.44%**, while combined elapsed time increased **3.76%**.

| Task | Eager tokens, including review | On-demand tokens, including review | Eager time | On-demand time | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Read inventory | 9,595 | 3,615 | 7.075 s | 5.852 s | Both passed |
| Repair clamp | 29,147 | 25,690 | 20.759 s | 27.931 s | Both passed |
| Repair pagination | 44,137 | 22,546 | 25.063 s | 21.101 s | Both passed |

## Evidence and limits

- Live model: `gpt-6.1-sol`, medium effort, native Codex provider. Existing automatic safety reviews used `gpt-5.6-luna`; their usage is included in the session-ledger totals. All six ledgers report complete billing coverage, with no pending generations or incidents.
- Six authorized runs: one attempt per arm on three synthetic fixtures, alternating order across task pairs, with a 120-second cap per run. All finished within the cap. Fresh profiles and workspaces excluded personal instructions, skills, MCP configuration and prior conversation. The existing login was copied privately with refresh disabled; the original credentials and settings were not modified.
- Token totals are provider-reported input plus output. Cached input is already part of input; reasoning is not added again. Token savings are not a dollar-cost estimate. No delegation was requested or performed.
- Startup is a separate loopback capture, locally tokenized with `o200k_base`: system text plus compact tool-definition JSON, excluding the user message and provider framing. Mock usage numbers are ignored. These startup estimates are not provider-reported token counts or an independently measured comparison with Pi.
- The code verifiers reject the broken fixtures and check boundary cases separately from the public tests. The inventory task checks the answer and unchanged source files. Small fixtures and one attempt per arm cannot establish general task-quality parity, reliability or latency superiority.
- Frozen live binary SHA-256: `f4eabdb10f2418dcbb1335f00623a785120922d6a0e24c5bc30bb5b52d0f9f76`. The six live runs preceded the final prompt compaction, successful-selection resume fix, and repository stabilization. They measure that pilot version, not the final release. No further paid inference was run.
- Final release SHA-256: `ab7545fe16f3be9eb4f07db4ca91cecbaa884b8e54504af3f2a3d127809dc305`. The startup capture contains 1,264 system tokens and 320 tool-definition tokens with on-demand loading, versus 4,105 tool-definition tokens eagerly. Temporary workspace paths affect the system count; earlier captures ranged from 1,579 to 1,594. Personal instructions, configured skills and MCP tools can increase it. The 1,600-token Pi figure was supplied by the user and has not been independently measured here.

Raw evidence: [final startup capture](../../output/on-demand-tools/ship-final-startup/measurement.json), [pilot startup capture](../../output/on-demand-tools/startup/measurement.json), [live configuration](../../output/on-demand-tools/live/state.json), [attempts](../../output/on-demand-tools/live/attempts.json), [summary](../../output/on-demand-tools/live/summary.json). Per-attempt responses, usage ledgers, traces, and edited source files are retained beside the summary. Private profiles and authentication files are not retained.

## Reproduce

Build a frozen binary without changing it during scored attempts:

```sh
zig build -Doptimize=ReleaseFast --prefix /absolute/output
```

Offline capture requires Python and `tiktoken`. Each output directory must be new:

```sh
python3 benchmarks/on-demand-tools/startup.py --binary /absolute/output/bin/handwork --out /absolute/results/startup
```

Live execution requires explicit authorization for six two-minute runs, the selected model entitlement, and an existing unexpired Handwork login. It consumes account usage:

```sh
python3 benchmarks/on-demand-tools/run.py --binary /absolute/output/bin/handwork --out /absolute/results/live --live
```

The loopback integration tests use no inference or real credentials:

```sh
HANDWORK_TEST_EXE=/absolute/output/bin/handwork python3 tests/e2e/on-demand-tools.py
```

## Validation

The final change passes five loopback integration tests: every original schema loads unchanged, invalid batches remain atomic, actual tool execution and resume work, denied tools stay unavailable, and disabling the loader retains all other tools. Resume also preserves successful unused selections without restoring failed selections. Focused Zig checks cover on-demand projection, loader validation, tool contracts, vision projection, and selected MCP schemas. See [validation record](../../output/on-demand-tools/validation.json).

The complete native suite passes: 8,725 passed, 4 skipped, no failures, crashes or leaks. The registration and timeout-fixture failures have been fixed. The final release also passes all five loopback integration tests and two npm launcher tests. All 54 terminal end-to-end test files are accounted for in completed per-file and batch runs: 1,114 passed, 52 skipped, no failures. See the [end-to-end audit](../../output/on-demand-tools/e2e-verification.json).

Desktop verification on Node 24.22.2 passes 5,080 web tests and TypeScript checking, 112 host tests and host build, and 624 Rust tests with formatting and Clippy checks. Current desktop release contracts pass 15 tests. Packaging scripts pass 25 tests; six retired engine workflow checks are skipped because those workflow files are absent from this checkout. Browser verification passes 126 tests across Chromium and WebKit, with two opt-in performance cases skipped. The final two repaired test files were rerun separately after the full browser run. The complete Node + N-API and Node + WASM SDK lanes pass, including terminal integration; the browser SDK passes all five scenarios. MCP conformance passes 435 current-protocol checks and five legacy-protocol checks.

Stabilization fixes include provider stream and file-size boundaries, transcript resizing, recording through linked home directories, WebAssembly builds and terminal authentication, native SDK host-managed authentication, and selecting text in desktop diffs. Outdated protocol fixtures and UI assertions were updated to the existing contracts without removing their behavior checks.

Live/opt-in tests, other operating systems, and actual signing/notarization/publication are not covered by these local results. The final full native rerun also passes all 8,725 tests with four skips. No enabled local check remains failing.
