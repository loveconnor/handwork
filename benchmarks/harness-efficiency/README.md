# Handwork harness efficiency

Implements and measures four priorities: reduce discovery rounds, measure/reduce repeated context, improve failure recovery and verification guidance, and expand evaluation beyond the original three fixtures.

- [Research and decisions](RESEARCH.md)
- [Final six-task paired report](results-final/REPORT.md)
- [Raw attempts](results-final/attempts.json), [frozen configuration and hashes](results-final/state.json)
- [Focused runtime checks](focused-tests.log), [trace integration check](trace-integration-tests.log)
- [Verification summary](verification.json); the broader API check includes one OpenCode startup error reproduced against baseline
- [Public-suite adapter and prerequisites](PUBLIC-BENCHMARKS.md)

## Reproduce

Build the desired baseline and candidate revisions into distinct output directories with Zig 0.16.0, using `zig build -Doptimize=ReleaseFast --prefix /absolute/output/path`. Preserve binary hashes and do not run builds during scored attempts.

```sh
python3 benchmarks/harness-efficiency/run.py \
  --baseline /absolute/baseline/bin/handwork \
  --optimized /absolute/candidate/bin/handwork \
  --out benchmarks/harness-efficiency/results-new \
  --attempts 2
```

The runner refuses to overwrite results. It uses the existing macOS sandbox benchmark infrastructure, Node/npm, Git, and the configured ChatGPT login used by the earlier studies. It temporarily stages Handwork authentication/settings via the existing runner and restores them after each attempt. Avoid running another benchmark or changing Handwork settings concurrently. It does not print or retain credentials in result artifacts.

Default development tasks: pagination, async search, tenant-cache. Reserved tasks: queue concurrency, tenant ledger atomicity, streamed JSONL recovery. Pass `--tasks` to run a subset; keep exploratory results separate from final scoring. A subset is not a six-task result.

```sh
python3 benchmarks/harness-efficiency/report.py benchmarks/harness-efficiency/results-new
```

The report retains failures and reports the development/held-out split separately. The held-out tasks were authored for this pilot and reserved from tuning; they are not externally audited or representative of every repository. The public Harbor adapter requires separate container validation before publication.

## Scoring and verification notes

All 24 scored attempts completed before an end-of-run report import collided with the older benchmark's module name. Report loading now resolves the sibling file explicitly; the saved attempts were used to generate the report without reruns. The raw scored runner and error log remain unchanged for audit, with the corrected runner saved separately.

Focused runtime checks, exact-result/durable-history integration, repeated-failure hint integration, and four Harbor dependency-contract checks passed. The broader API regression run passed five of six tests, including the provider matrix. The fixed-port OpenCode autostart test failed with a missing launch-arguments file against both frozen baseline and candidate. This is not presented as a clean full-suite result. The exact scored candidate is installed at `zig-out/bin/handwork`.
