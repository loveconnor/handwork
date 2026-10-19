"""Offline behavioral tests. Synthetic traces do not establish native runtime correctness."""
import hashlib
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import accounting
import study
import run


def trace(request_id=1, child=0, admitted=True, purpose="generation", **overrides):
    identity = f" subagent_id={child}" if child else ""
    fields = {"request_id": request_id, "purpose": purpose, "status": "completed", "admitted": str(admitted).lower(),
              "possibly_sent": "true", "elapsed_ms": 5, "input_known": "true",
              "output_known": "true", "cache_known": "true", "input": 100,
              "output": 10, "cached": 60, "consistent": "true"}
    fields.update(overrides)
    start = f"0 [agent] event=request_attempt_started request_id={request_id} purpose={purpose}{identity}\n"
    admission = f"1 [agent] event=provider_admitted request_id={request_id}{identity}\n" if admitted else ""
    end = "2 [agent] event=request_accounting " + " ".join(f"{k}={v}" for k, v in fields.items()) + identity + "\n"
    return start + admission + end


def records():
    rows = []
    for item in study.schedule():
        candidate = item["arm"] == "candidate"
        usage = {"input": 90 if candidate else 100, "output": 10, "cached": 30,
                 "uncached": 60 if candidate else 70}
        purposes = {purpose: dict.fromkeys((*usage, "admitted_requests"), 0)
                    for purpose in accounting.PURPOSES}
        purposes["generation"] = dict(usage, admitted_requests=1)
        rows.append(dict(item, success=True, duration_s=95 if candidate else 100,
                         accounting={"eligible": True, "usage": usage, "purpose_usage": purposes}))
    return rows


class AccountingTests(unittest.TestCase):
    def test_root_children_and_compaction_are_counted_once(self):
        result = accounting.reconcile(trace() + trace(2, child=7) + trace(3, purpose="compaction"))
        self.assertTrue(result["eligible"])
        self.assertEqual(result["usage"], {"input": 300, "output": 30, "cached": 180, "uncached": 120})
        self.assertEqual(result["root_usage"]["input"], 200)
        self.assertEqual(result["child_usage"]["input"], 100)
        self.assertEqual(result["purpose_usage"]["generation"]["input"], 200)
        self.assertEqual(result["purpose_usage"]["compaction"]["input"], 100)
        self.assertEqual(result["purpose_usage"]["image"]["admitted_requests"], 0)

    def test_purpose_missing_invalid_or_mismatched_is_ineligible(self):
        lines = trace().splitlines()
        for text in (trace().replace(" purpose=generation", ""),
                     "\n".join([lines[0].replace("generation", "image"), *lines[1:]]),
                     "\n".join([*lines[:2], lines[2].replace("generation", "compaction")]),
                     trace(purpose="unknown"),
                     "\n".join([lines[0].replace(" purpose=generation", ""), *lines[1:]]),
                     "\n".join([*lines[:2], lines[2].replace(" purpose=generation", "")])):
            result = accounting.reconcile(text)
            self.assertFalse(result["eligible"])
            self.assertIsNone(result["purpose_usage"])

    def test_all_purposes_include_child_work_and_distinguish_missing_from_zero(self):
        text = trace() + trace(2, child=7, purpose="compaction") + trace(3, purpose="image", input=0, cached=0, output=0)
        result = accounting.reconcile(text)
        self.assertTrue(result["eligible"])
        self.assertEqual(result["purpose_usage"]["image"],
                         {"input": 0, "output": 0, "cached": 0, "uncached": 0, "admitted_requests": 1})
        for key in (*accounting.FIELDS, "uncached"):
            self.assertEqual(sum(p[key] for p in result["purpose_usage"].values()), result["usage"][key])
        for purpose in accounting.PURPOSES:
            for flag in ("input_known", "output_known", "cache_known"):
                failed = accounting.reconcile(trace(purpose=purpose, **{flag: "false", "input": 0, "output": 0, "cached": 0}))
                self.assertFalse(failed["eligible"])
                self.assertIsNone(failed["purpose_usage"])

    def test_normalized_cached_heavy_input_is_not_normalized_twice(self):
        result = accounting.reconcile(trace(input=1010, cached=900, output=20))
        self.assertTrue(result["eligible"])
        self.assertEqual(result["usage"], {"input": 1010, "cached": 900, "output": 20, "uncached": 110})

    def test_known_zero_differs_from_unavailable_placeholder(self):
        self.assertTrue(accounting.reconcile(trace(input=0, output=0, cached=0))["eligible"])
        for flag in ("input_known", "output_known", "cache_known"):
            result = accounting.reconcile(trace(**{flag: "false", "input": 0, "output": 0, "cached": 0}))
            self.assertFalse(result["eligible"])
            self.assertIsNone(result["usage"])

    def test_failed_and_transport_failure_are_ineligible_even_unadmitted(self):
        for status in ("failed", "transport_failed", "unknown"):
            self.assertFalse(accounting.reconcile(trace(status=status, admitted=False))["eligible"])

    def test_only_admitted_requests_contribute(self):
        result = accounting.reconcile(trace() + trace(2, admitted=False))
        self.assertTrue(result["eligible"])
        self.assertEqual(result["usage"]["input"], 100)

    def test_missing_duplicate_or_orphan_events_fail_closed(self):
        lines = trace().splitlines(keepends=True)
        for text in ("", trace() + trace(), "".join(lines[:-1]), "".join(lines[1:]),
                     lines[0] + lines[2], "".join(lines) + lines[1]):
            with self.subTest(text=text):
                self.assertFalse(accounting.reconcile(text)["eligible"])

    def test_unordered_interleaving_is_supported(self):
        lines = (trace() + trace(2, child=9)).splitlines()
        self.assertTrue(accounting.reconcile("\n".join(reversed(lines)))["eligible"])

    def test_cache_inconsistent_invalid_or_duplicate_fields(self):
        for text in (trace(cached=101), trace(consistent="false"), trace(input=-1),
                     trace(output="nan"), trace(cache_known="1"), trace(elapsed_ms=-1),
                     trace() .replace("input=100", "input=100 input=100"),
                     trace().replace("request_id=1", "request_id=0")):
            self.assertFalse(accounting.reconcile(text)["eligible"])

    def test_child_identity_mismatch_fails(self):
        text = trace(child=9).replace("status=completed", "status=completed subagent_id=8")
        self.assertFalse(accounting.reconcile(text)["eligible"])


class ProtocolTests(unittest.TestCase):
    def test_schedule_is_fixed_balanced_and_serial(self):
        rows = study.schedule()
        self.assertEqual(len(rows), 24)
        self.assertEqual(len({r["id"] for r in rows}), 24)
        for task in study.TASKS:
            first = [r["arm"] for r in rows if r["task"] == task and r["pair"] == 1]
            second = [r["arm"] for r in rows if r["task"] == task and r["pair"] == 2]
            self.assertEqual(first, list(reversed(second)))

    def test_one_feature_and_no_inherited_flags_or_trace_destination(self):
        inherited = {study.PREFIX + "VERIFY_COMPLETION": "1", study.PREFIX + "BOUNDED_DELEGATION": "1", "HANDWORK_TRACE_LOG": "/bad", "PATH": "/bin"}
        baseline = study.arm_env(inherited, {})
        candidate = study.arm_env(inherited, study.controls("COMPACT_SCHEMAS"))
        self.assertEqual({k: v for k, v in baseline.items() if k.startswith(study.PREFIX)},
                         {study.PREFIX + "BOUNDED_DELEGATION": "0"})
        self.assertEqual({k: v for k, v in candidate.items() if k.startswith(study.PREFIX)},
                         {study.PREFIX + "BOUNDED_DELEGATION": "0", study.PREFIX + "COMPACT_SCHEMAS": "1"})
        self.assertNotIn("HANDWORK_TRACE_LOG", candidate)
        self.assertEqual(candidate["HANDWORK_TRACE_SCOPES"], baseline["HANDWORK_TRACE_SCOPES"])
        self.assertEqual(study.controls("BOUNDED_DELEGATION"), {study.PREFIX + "BOUNDED_DELEGATION": "1"})
        bounded = study.arm_env(inherited, study.controls("BOUNDED_DELEGATION"))
        self.assertEqual({k: v for k, v in bounded.items() if k.startswith(study.PREFIX)},
                         {study.PREFIX + "BOUNDED_DELEGATION": "1"})

    def test_budget_ablation_does_not_enable_another_feature(self):
        self.assertEqual(study.controls("MAX_REQUESTS", 4), {study.PREFIX + "MAX_REQUESTS": "4"})
        for feature, value in (("MAX_TOKENS", 0), ("MAX_CHILDREN", True), ("unknown", None), ("COMPACT_SCHEMAS", 5)):
            with self.assertRaises(ValueError):
                study.controls(feature, value)

    def test_promotes_only_complete_correct_eligible_pairs(self):
        manifest = {"schedule": study.schedule()}
        self.assertTrue(study.evaluate(manifest, records())["promote"])
        variants = [records()[:-1], records() + records()[:1]]
        for field, value in (("success", False), ("duration_s", math.nan), ("duration_s", 601)):
            rows = records(); rows[0][field] = value; variants.append(rows)
        rows = records(); rows[0]["accounting"]["eligible"] = False; variants.append(rows)
        for rows in variants:
            self.assertFalse(study.evaluate(manifest, rows)["promote"])

    def test_report_preserves_per_task_and_aggregate_purpose_totals(self):
        rows = records()
        for row in rows:
            row["accounting"]["purpose_usage"]["compaction"] = row["accounting"]["purpose_usage"]["generation"]
            row["accounting"]["purpose_usage"]["generation"] = dict.fromkeys(("input", "output", "cached", "uncached", "admitted_requests"), 0)
        result = study.evaluate({"schedule": study.schedule()}, rows)
        self.assertTrue(result["promote"])
        self.assertEqual(result["tasks"]["pagination"]["baseline"]["purpose_usage"]["compaction"]["input"], 200)
        self.assertEqual(result["aggregate"]["candidate"]["purpose_usage"]["compaction"]["admitted_requests"], 12)
        self.assertEqual(result["aggregate"]["candidate"]["purpose_usage"]["image"]["input"], 0)
        rows[0]["accounting"].pop("purpose_usage")
        self.assertFalse(study.evaluate({"schedule": study.schedule()}, rows)["promote"])

    def test_per_task_token_and_time_gates_cannot_be_hidden_by_aggregate(self):
        for key in ("input", "output", "duration_s"):
            rows = records()
            for row in rows:
                if row["arm"] == "candidate" and row["task"] == "tenant-cache":
                    if key == "duration_s": row[key] = 105.001
                    else: row["accounting"]["usage"][key] = 101
            self.assertFalse(study.evaluate({"schedule": study.schedule()}, rows)["promote"])

    def test_gate_boundaries_and_no_aggregate_gain(self):
        rows = records()
        for row in rows:
            if row["arm"] == "candidate": row["duration_s"] = 105
        self.assertTrue(study.evaluate({"schedule": study.schedule()}, rows)["promote"])
        for row in rows:
            if row["arm"] == "candidate":
                row["duration_s"] = 100
                row["accounting"]["usage"]["input"] = 100
        self.assertFalse(study.evaluate({"schedule": study.schedule()}, rows)["promote"])

    def test_context_and_manifest_mutation_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "binary"; binary.write_bytes(b"offline")
            context = Path(directory) / "instructions.md"; context.write_text("frozen")
            with patch.object(study, "source_files", return_value={}):
                manifest = study.freeze(run.ROOT, binary, {"context_hashes": {str(context): study.sha(context)}}, "TASK_EVIDENCE")
                study.verify_manifest(manifest)
                context.write_text("changed")
                with self.assertRaisesRegex(ValueError, "context drift"):
                    study.verify_manifest(manifest)
                manifest["trace"] = {}
                with self.assertRaisesRegex(ValueError, "digest mismatch"):
                    study.verify_manifest(manifest)

    def test_exclusive_records_preserve_first_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "record.json"
            study.write_new(path, {"failure": True})
            with self.assertRaises(FileExistsError): study.write_new(path, {"failure": False})
            self.assertEqual(run.load(path), {"failure": True})

    def test_duplicate_json_keys_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.json"; path.write_text('{"a":1,"a":2}')
            with self.assertRaises(ValueError): run.load(path)

    def test_results_named_runtime_source_is_included_and_drift_invalidates_freeze(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            files = ("src/results/probe.zig", ".agents/skills/probe/SKILL.md", "AGENTS.md", "README.md",
                     "build.zig", "build.zig.zon", "package.json", "package-lock.json",
                     "benchmarks/orchestration-study/study.py", "benchmarks/harness-efficiency/run.py",
                     "benchmarks/harness-efficiency/report.py", "benchmarks/harness-efficiency/tasks.py",
                     "benchmarks/harness-efficiency/results-final/state.json", "benchmarks/fixed-budget/pilot.py",
                     "benchmarks/async-search/benchmark.py", "benchmarks/async-search/verify.mjs",
                     "benchmarks/async-search/fixture/probe.ts", "benchmarks/tenant-cache/fixture/probe.ts",
                     "benchmarks/tenant-cache/results/state.json", "benchmarks/tool-batching/verify-tenant.mjs")
            for name in files:
                path = repo / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("original\n")
            probe = repo / "src/results/probe.zig"
            self.assertEqual(study.source_files(repo)["src/results/probe.zig"], study.sha(probe))
            binary = repo / "offline-binary"
            binary.write_bytes(b"synthetic; never executed")
            with patch.object(study.subprocess, "check_output", return_value="offline-head\n"):
                manifest = study.freeze(repo, binary, {}, "COMPACT_SCHEMAS")
            study.verify_manifest(manifest)
            probe.write_text("changed\n")
            with self.assertRaisesRegex(ValueError, "source/fixture/schema drift"):
                study.verify_manifest(manifest)
            probe.write_text("original\n")
            study.verify_manifest(manifest)
            (probe.parent / "new.zig").write_text("new untracked source\n")
            with self.assertRaisesRegex(ValueError, "source/fixture/schema drift"):
                study.verify_manifest(manifest)

    def test_working_source_hashes_include_untracked_schema_and_detect_drift(self):
        hashes = study.source_files(run.ROOT)
        self.assertIn("src/core/agent/runtime/request_accounting.zig", hashes)
        self.assertIn("src/core/tooling/model_tool_schema.zig", hashes)
        self.assertIn("benchmarks/harness-efficiency/results-final/state.json", hashes)
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "binary"; binary.write_bytes(b"fresh-offline-fixture")
            with patch.object(study, "source_files", return_value={"src/new.zig": "old"}):
                manifest = study.freeze(run.ROOT, binary, {}, "COMPACT_SCHEMAS")
                study.verify_manifest(manifest)
            with patch.object(study, "source_files", return_value={"src/new.zig": "changed"}):
                with self.assertRaises(ValueError): study.verify_manifest(manifest)
            binary.write_bytes(b"changed")
            with self.assertRaises(ValueError): study.verify_manifest(manifest)


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.directory = Path(self.temp.name)
        for name in ("starts", "attempts"): (self.directory / name).mkdir()
        self.manifest = {"schedule": study.schedule(), "manifest_sha256": "frozen", "binary_sha256": "binary",
                         "candidate_controls": study.controls("COMPACT_SCHEMAS"),
                         "configuration": {"tasks": {task: {"fixture_hashes": {}, "prompt": task,
                         "verifier_sha256": "verifier"} for task in study.TASKS}}}
        study.write_new(self.directory / "manifest.json", self.manifest)
        self.verification = patch.object(run, "verify_manifest"); self.verification.start()
        self.addCleanup(self.verification.stop); self.addCleanup(self.temp.cleanup)

    def test_record_rejects_path_escape_before_reading_artifacts(self):
        with self.assertRaisesRegex(ValueError, "outside frozen schedule"):
            run.record(self.directory, "../../outside", self.directory / "missing",
                       self.directory / "missing", self.directory / "missing")

    def test_start_records_before_execution_and_interruption_blocks(self):
        first = study.schedule()[0]["id"]
        run.begin(self.directory, first)
        with self.assertRaises(FileExistsError): run.begin(self.directory, first)
        with self.assertRaises(ValueError): run.begin(self.directory, study.schedule()[1]["id"])
        result = run.report(self.directory)
        self.assertFalse(result["promote"])
        self.assertEqual(result["started_without_terminal"], [first])

    def test_unavailable_usage_is_retained_and_stops_next_attempt(self):
        first = run.begin(self.directory, study.schedule()[0]["id"])
        study.write_new(self.directory / "bundle.json", {})
        study.write_new(self.directory / "stdout.json", {})
        (self.directory / "trace.log").write_text(trace(input_known="false", input=0, cached=0))
        row = run.record(self.directory, first["id"], self.directory / "bundle.json",
                         self.directory / "trace.log", self.directory / "stdout.json")
        self.assertFalse(row["success"])
        self.assertIsNone(row["accounting"]["usage"])
        self.assertTrue((self.directory / "attempts" / (first["id"] + ".json")).exists())
        with self.assertRaisesRegex(ValueError, "usage unavailable"):
            run.begin(self.directory, study.schedule()[1]["id"])

    def test_record_keeps_failure_and_does_not_use_main_only_cli_usage(self):
        first = run.begin(self.directory, study.schedule()[0]["id"])
        bundle = {"manifest_sha256": "frozen", "binary_sha256": "binary", "trace": study.TRACE,
                  "controls": {}, "task_contract_sha256": study.digest(self.manifest["configuration"]["tasks"][first["task"]]),
                  "initial_fixture_hashes": {}, "verifier_sha256": "verifier",
                  "prompt_sha256": hashlib.sha256(first["task"].encode()).hexdigest(),
                  "duration_s": 10, "exit_code": 0, "timeout": False}
        for key in ("fresh_workspace", "fresh_session", "protected_files_unchanged", "no_dependencies",
                    "existing_tests_pass", "private_checks_pass", "broken_control_rejected",
                    "known_correct_control_passed", "host_profile_write_denied", "context_hashes_verified"):
            bundle[key] = True
        for name, value in (("bundle.json", bundle), ("stdout.json", {"exit_code": 0, "final_output": "done",
                              "model": study.PROTOCOL["model"], "usage": {"input_tokens": 999999}})):
            study.write_new(self.directory / name, value)
        (self.directory / "trace.log").write_text(trace() + trace(2, child=3))
        row = run.record(self.directory, first["id"], self.directory / "bundle.json",
                         self.directory / "trace.log", self.directory / "stdout.json")
        self.assertTrue(row["success"])
        self.assertEqual(row["accounting"]["usage"]["input"], 200)
        self.assertEqual(run.report(self.directory)["reasons"], ["incomplete, duplicate, or unexpected attempts"])
        artifact = self.directory / "artifacts" / first["id"] / "trace"
        artifact.write_text("changed")
        self.assertTrue(any("changed artifact" in reason for reason in run.report(self.directory)["reasons"]))
        with self.assertRaises(FileExistsError):
            run.record(self.directory, first["id"], self.directory / "bundle.json",
                       self.directory / "trace.log", self.directory / "stdout.json")


if __name__ == "__main__":
    unittest.main()
