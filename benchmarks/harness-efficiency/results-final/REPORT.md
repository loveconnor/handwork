# Handwork harness efficiency: paired results

Model: gpt-6-astra; effort: low; 2 attempts per variant per task; 600-second wall budget.

Both variants are native ReleaseFast builds. Runs are serial and alternate variant order. Every attempt is retained. These are small local fixtures, not public leaderboard scores.

## Development

| Task | Passed baseline → candidate | Median successful seconds | Mean input tokens | Mean output tokens | Mean model requests | Median agent MiB |
|---|---:|---:|---:|---:|---:|---:|
| pagination | 2/2 → 2/2 | 28.3 → 27.2 | 31345.5 → 25642.0 | 522.5 → 538.0 | 5.0 → 4.0 | 23.3 → 21.4 |
| search | 2/2 → 2/2 | 46.7 → 44.2 | 46906.5 → 36975.5 | 1061.0 → 940.0 | 6.5 → 5.0 | 26.2 → 23.6 |
| tenant-cache | 2/2 → 2/2 | 80.4 → 90.8 | 70946.0 → 82053.5 | 2021.5 → 2290.5 | 8.0 → 8.0 | 28.5 → 28.8 |

Across all attempts in this split: duration_s +4.3%, input_tokens -3.0%, output_tokens +4.5%, model_requests -12.8%, tool_calls -5.0%.

## Held Out

| Task | Passed baseline → candidate | Median successful seconds | Mean input tokens | Mean output tokens | Mean model requests | Median agent MiB |
|---|---:|---:|---:|---:|---:|---:|
| ledger | 2/2 → 2/2 | 59.9 → 51.9 | 46864.5 → 27598.0 | 1383.5 → 1379.0 | 7.0 → 4.0 | 26.7 → 22.1 |
| queue | 2/2 → 2/2 | 52.4 → 43.3 | 55438.5 → 33201.5 | 1070.0 → 1069.5 | 8.5 → 5.0 | 28.7 → 23.6 |
| stream | 2/2 → 2/2 | 55.2 → 48.2 | 46739.0 → 34209.5 | 1234.5 → 1210.0 | 7.0 → 5.0 | 26.6 → 23.5 |

Across all attempts in this split: duration_s -14.4%, input_tokens -36.3%, output_tokens -0.8%, model_requests -37.8%, tool_calls -25.5%.

## Diagnostics

Candidate request-composition events: 62. Duplicate-result bytes removed across request projections: 0. Repeated-failure hints: 0.

Mean bytes per candidate request (diagnostic categories, not tokens):

- instruction_bytes: 9,311
- conversation_bytes: 818
- tool_result_bytes: 10,188
- tool_argument_bytes: 1,568
- replay_bytes: 892
- schema_json_bytes: 16,106
- wire_bytes: 40,584

## Integrity and limits

- Existing tests, private behavioral checks, protected files, and time budget all count toward success. All token totals include failed attempts.
- Broken/known-correct control outcomes are saved beside the results. Fixture and verifier hashes and frozen executable hashes are recorded in state.json.
- Development and held-out tasks are reported separately. No runtime tuning follows held-out results.
- Two pairs per task cannot establish a general speed advantage. Completion times include inference and network variability. The six tasks do not cover large repositories, multiple languages, or multi-hour sessions.
- Byte accounting is not provider tokenization; input includes cache hits. Memory measures local agent RSS, excluding hosted inference; tool/test subprocess memory is recorded separately.
- No dollar-cost comparison, competitor rerun, official SWE-bench/Terminal-Bench score, or 20% speed guarantee is claimed. Docker preflight was unavailable.
- Both variants inherit the existing personal Handwork context and load the unslop skill; this is not a pristine-profile evaluation. Available global context hashes were sampled during the run in observed-global-context-hashes.json; a later match does not prove no earlier changes. The sandbox reports inaccessible compatibility skill roots for both variants.
- Candidate-only detailed tracing adds measurement overhead. Both variants enable the existing agent trace stream.

## Acceptance target

Target: at least 20% lower total completion time for the equally repeated task mix, all candidate attempts correct, and neither input nor output tokens increasing. This descriptive pilot threshold is not a significance test.

- development: not met.
- held_out: not met.

Per-task regression checks use all-attempt token means and matched-success timing:

- ledger: no observed regression on these checks.
- pagination: output_tokens increased.
- queue: no observed regression on these checks.
- search: no observed regression on these checks.
- stream: no observed regression on these checks.
- tenant-cache: input_tokens increased; output_tokens increased; matched-success median time increased.

Failed attempts: none.
