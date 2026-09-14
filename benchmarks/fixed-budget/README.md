# Fixed-budget pagination pilot

Open [the report](../../benchmark-results.html). It is a self-contained HTML file; the relative evidence links resolve against this repository.

The reported series uses the app-bundled Codex CLI 0.153.4, OpenCode 1.18.25, and the frozen Handwork 0.0.8 binary with `gpt-6-astra`, low reasoning, a 272,000-token client/catalog context window, and the existing ChatGPT subscription connection. No Ollama server is used. The TypeScript fixture needs only Node 24 and has no external packages.

## Corrected benchmark

The current report uses `results/corrected/`: a fresh nine-attempt series after fixing the benchmark sandbox. The earlier **Handwork 0/3** comparison is withdrawn. It was caused by the benchmark denying a shared ancestor directory that Handwork’s path resolver needed to open, not by its ability to fix pagination.

The sandbox now denies the private verifier and sibling directories explicitly while preserving ancestor traversal. A regression test verifies permitted reads/writes and denied verifier/sibling/symlink access. Before timed tasks, all three harnesses perform a separate native file read, edit, and successful shell check. No Handwork implementation, model, prompt, starting commit, or time budget changed.

Both earlier series remain visible in the report’s audit section: nine dependency-initialization rehearsal attempts under `results/`, and nine invalid-sandbox attempts under `results/final/`. Their original raw outcomes are preserved, including the three blocked Handwork attempts. The corrected nine attempts alone determine the headline. Total pagination task executions across the three series: 27.

## Files

- `pilot.py`: fixture construction, authentication staging, sandbox, serial rotated runs, token parsing, process sampling and independent verification.
- `test_sandbox.py`: regression coverage for ancestor traversal and protected content, including symlinks.
- `startup.py`: PTY startup probes. A marker is typed but never submitted. Codex's TUI does not have the same config isolation flags as `codex exec`; see the report caveat.
- `report.py`: regenerate `../../benchmark-results.html` and the structured report data.
- `results/state.json`: starting commit, model settings, machine, prompt and private fixture location.
- `results/verifier-control.json`: original-code rejection and known-correct-code acceptance.
- `results/sandbox-audit.json`: historical direct-read probe that missed the ancestor problem. The corrected series adds `native-tool-audit.json`, `smoke.json`, and raw native-tool preflight logs.
- `results/corrected/attempts.json`: task outcomes, wall time, separate RSS categories, token counts and verification outcomes.
- `results/corrected/*.stdout`, `*.stderr`, `*.diff`, `*.memory.json`: raw evidence.
- `results/corrected/report-data.json`: complete data used by the HTML, including both excluded series, native tool checks, startup and installation inventory.
- `results/corrected/*.sandbox.sb`: exact sandbox profile for each attempt.
- `results/corrected/runner-snapshot.py`: runner source captured before the corrected series.

## Measurement definitions

Each timed attempt launches a fresh harness with the exact prompt and a fresh clone at the recorded starting commit. The budget is 300 seconds. Timing ends when the process exits; it includes client initialization and model/network latency. The prompt is not given any corrective hints. Native prompts/tool systems differ intentionally.

The memory sampler polls roughly every 70–85 ms (40 ms sleep plus `ps` overhead). It sums concurrent RSS by category and retains the maximum per attempt. RSS includes shared mappings and is not unique physical memory. Very short processes may be missed. Test descendants and other tools are separated; post-run checks have their own sampling. The headline uses the median of the three peak harness RSS values and includes failed runs. It must be read alongside correctness.

OpenCode input adds uncached input and cache reads/writes; output adds visible and reasoning tokens. Codex and Handwork use their reported cumulative usage. OpenCode's final-series title is supplied explicitly to avoid auxiliary title generation. These are client-reported counts, not a server-side billing audit. Unknown token fields remain null. Tool calls count native invocations, including failed calls; a shell tool can contain multiple commands.

Installation inventory counts uncompressed harness binaries and their distributed/runtime packages, excludes model weights, the desktop UI, OS libraries and shared developer tools. Exact components and executable SHA-256 hashes are embedded in the report data.

The hosted backend exposes neither model-server RSS nor reproducible cold model loading, quantization, or hardware placement. Those metrics are unavailable. Startup probes measure a new process's editable prompt on a warm filesystem, not readiness of hosted inference.

## Reproduction

Run `python3 benchmarks/fixed-budget/test_sandbox.py` for the regression test. The corrected series was executed with `python3 benchmarks/fixed-budget/pilot.py corrected`, followed by `python3 benchmarks/fixed-budget/report.py`. The runner refuses to overwrite existing attempts or a corrected runner snapshot; use a separate results location for future series.

The corrected command performs native tool preflights before starting all nine scored attempts. OpenCode runtime packages and catalog cache are copied from the preinstalled seed without credentials, prompts, sessions or fixes. Each attempt uses a new clone and session. Startup measurements are retained from the earlier separate PTY probes and carry the report’s configuration caveat.

No Handwork source was changed for this correction. Authentication is staged only for each process, restored afterward, and removed from temporary profiles. The delivered report contains no credential values.
