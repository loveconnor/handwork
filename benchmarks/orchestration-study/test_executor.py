"""Offline executor checks. No native binary, auth, builds, or model calls."""
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import executor
from study import TRACE, schedule, write_new

ROOT = Path(__file__).resolve().parents[2]


class ExecutorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.directory = self.base / "study"
        self.directory.mkdir()
        for name in ("starts", "attempts"):
            (self.directory / name).mkdir()

    def manifest(self):
        binary = self.base / "handwork-offline-fixture"
        binary.write_bytes(b"never launch this fixture")
        config = executor.load(ROOT / "benchmarks/harness-efficiency/results-final/state.json")
        config = {"model": config["model"], "effort": config["effort"],
                  "tasks": {t["task"]: {k: t[k] for k in ("prompt", "fixture_hashes", "verifier_sha256")}
                            for t in config["tasks"]}}
        return {"manifest_sha256": "frozen", "schedule": schedule(), "repo": str(ROOT),
                "configuration": config, "binary": str(binary),
                "candidate_controls": {"HANDWORK_EXPERIMENT_TASK_EVIDENCE": "1"},
                "baseline_controls": {}, "trace": TRACE}

    def test_arguments_keep_entire_task_in_prompt(self):
        task = "--resume last; $(touch /host)\n`echo injected`"
        argv = executor.native_argv("/tmp/path with spaces/native", task)
        self.assertEqual(argv[-2:], ["--", task])
        self.assertIn("--no-save", argv)
        self.assertNotIn("--resume", argv)
        self.assertEqual(argv.count(task), 1)

    def test_environment_is_sanitized_and_equal_except_arm_control(self):
        original = {"HOME": "/host", "PATH": "/usr/bin:/bin", "LANG": "C",
                    "HANDWORK_EXPERIMENT_MAX_CHILDREN": "99", "HANDWORK_TRACE_STDERR": "0",
                    "HANDWORK_TRACE_SCOPES": "all", "OPENAI_API_KEY": "do-not-copy",
                    "BASH_ENV": "/host/inject", "DYLD_INSERT_LIBRARIES": "/host/inject",
                    "NODE_OPTIONS": "--require=/host/inject", "GIT_CONFIG_COUNT": "4"}
        snapshot = dict(original)
        controls = {"HANDWORK_EXPERIMENT_TASK_EVIDENCE": "1"}
        baseline = executor.native_env(original, {}, "/fresh/tmp")
        candidate = executor.native_env(original, controls, "/fresh/tmp")
        self.assertEqual(candidate, dict(baseline, **controls))
        self.assertEqual(original, snapshot)
        self.assertEqual({k: baseline[k] for k in TRACE}, TRACE)
        self.assertEqual(set(baseline) & set(original), {"HOME", "PATH", "LANG", *TRACE})
        self.assertEqual(baseline["GIT_CONFIG_GLOBAL"], "/dev/null")

    def test_all_six_fixtures_match_frozen_hashes_exactly(self):
        state = executor.load(ROOT / "benchmarks/harness-efficiency/results-final/state.json")
        self.assertEqual(len(state["tasks"]), 6)
        for contract in state["tasks"]:
            with self.subTest(task=contract["task"]):
                files, verifier, prompt = executor.fixture_files(ROOT, contract["task"])
                result = executor.verify_fixture(files, verifier, prompt, contract)
                self.assertEqual(result, contract["fixture_hashes"])

    def test_fixture_drift_added_missing_content_prompt_verifier(self):
        files = {"src/a.js": b"broken"}
        verifier, prompt = b"private", "fix"
        contract = {"fixture_hashes": {"src/a.js": hashlib.sha256(b"broken").hexdigest()},
                    "verifier_sha256": hashlib.sha256(verifier).hexdigest(), "prompt": prompt}
        cases = [(dict(files, extra=b"x"), verifier, prompt), ({}, verifier, prompt),
                 ({"src/a.js": b"changed"}, verifier, prompt), (files, b"wrong", prompt),
                 (files, verifier, "wrong")]
        for values in cases:
            with self.subTest(values=values):
                with self.assertRaises(executor.Blocked):
                    executor.verify_fixture(*values, contract)

    def test_constant_loader_never_imports_or_executes_legacy_code(self):
        path = self.base / "legacy.py"
        marker = self.base / "must-not-exist"
        path.write_text(f"import missing_dependency\nopen({str(marker)!r}, 'w').write('bad')\n"
                        "SOURCE = 'data'\nTASKS = {}\nTASKS['x'] = {'files': {}}\n"
                        "def credentials(): raise AssertionError('never call')\n")
        values = executor.literal_assignments(path)
        self.assertEqual(values, {"SOURCE": "data", "TASKS": {"x": {"files": {}}}})
        self.assertFalse(marker.exists())

    def test_selects_only_next_and_refuses_interrupted_attempt(self):
        manifest = self.manifest()
        first = manifest["schedule"][0]
        self.assertEqual(executor.next_attempt(self.directory, manifest), first)
        write_new(self.directory / "starts" / (first["id"] + ".json"),
                  dict(first, manifest_sha256="frozen"))
        with self.assertRaisesRegex(executor.Blocked, "interrupted"):
            executor.next_attempt(self.directory, manifest)
        write_new(self.directory / "attempts" / (first["id"] + ".json"),
                  dict(first, manifest_sha256="frozen", accounting={"eligible": True}))
        self.assertEqual(executor.next_attempt(self.directory, manifest), manifest["schedule"][1])

    def test_rejects_ineligible_wrong_identity_and_journal_gaps(self):
        manifest = self.manifest()
        first, second = manifest["schedule"][:2]
        start = self.directory / "starts" / (second["id"] + ".json")
        terminal = self.directory / "attempts" / start.name
        write_new(start, dict(second, manifest_sha256="frozen"))
        write_new(terminal, dict(second, manifest_sha256="frozen", accounting={"eligible": True}))
        with self.assertRaisesRegex(executor.Blocked, "out-of-order"):
            executor.next_attempt(self.directory, manifest)
        start.unlink()
        terminal.unlink()
        start = self.directory / "starts" / (first["id"] + ".json")
        terminal = self.directory / "attempts" / start.name
        write_new(start, dict(first, manifest_sha256="frozen"))
        write_new(terminal, dict(first, manifest_sha256="frozen", accounting={"eligible": False}))
        with self.assertRaisesRegex(executor.Blocked, "usage unavailable"):
            executor.next_attempt(self.directory, manifest)
        terminal.write_text(json.dumps(dict(first, manifest_sha256="wrong")))
        with self.assertRaisesRegex(executor.Blocked, "manifest mismatch"):
            executor.next_attempt(self.directory, manifest)

    def test_rejects_symlink_journal(self):
        manifest = self.manifest()
        name = manifest["schedule"][0]["id"] + ".json"
        (self.directory / "starts" / name).symlink_to(self.base / "absent")
        with self.assertRaisesRegex(executor.Blocked, "symlinked"):
            executor.next_attempt(self.directory, manifest)

    def test_execution_gate_persists_blocker_without_start_or_host_mutation(self):
        manifest = self.manifest()
        write_new(self.directory / "manifest.json", manifest)
        host = self.base / "host"
        (host / ".handwork").mkdir(parents=True)
        (host / ".handwork/settings.json").write_bytes(b"do not read or write")
        before = {p.relative_to(self.base): p.read_bytes() for p in self.base.rglob("*") if p.is_file()}
        out = self.base / "evidence"
        with patch.object(executor, "verify_manifest") as verify, \
                patch.dict(os.environ, {"HOME": str(host)}), \
                patch.object(executor.subprocess, "Popen", side_effect=AssertionError("no launch")), \
                patch("builtins.print"):
            self.assertEqual(executor.main([str(self.directory), "--out", str(out), "--execute"]), 2)
            verify.assert_called_once_with(manifest)
        report = executor.load(out / "blocker.json")
        self.assertEqual(report["model_calls"], 0)
        self.assertFalse(report["attempt_started"])
        self.assertEqual(len(report["blockers"]), 3)
        self.assertNotIn("fresh_session", report)
        self.assertNotIn("host_profile_write_denied", report)
        self.assertEqual(list((self.directory / "starts").iterdir()), [])
        for path, content in before.items():
            self.assertEqual((self.base / path).read_bytes(), content)
        self.assertEqual((out / "blocker.json").stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            executor.main([str(self.directory), "--out", str(out)])

    def test_profile_paths_are_rejected_before_any_hashing(self):
        manifest = self.manifest()
        profile = self.base / ".handwork"
        profile.mkdir()
        settings = profile / "settings.json"
        settings.write_bytes(b"never inspect these bytes")
        manifest["binary"] = str(settings)
        write_new(self.directory / "manifest.json", manifest)
        with patch.object(executor, "verify_manifest", side_effect=AssertionError("no hash")), \
                patch("builtins.print"):
            self.assertEqual(executor.main([str(self.directory), "--out", str(self.base / "evidence")]), 2)
        result = executor.load(self.base / "evidence/blocker.json")
        self.assertIn("never a profile", result["blockers"][0])

    def test_host_context_is_rejected_even_if_it_uses_markdown_extension(self):
        manifest = self.manifest()
        host_context = self.base / "host-settings.md"
        host_context.write_bytes(b"not an approved checkout context")
        manifest["configuration"]["context_hashes"] = {str(host_context): "not-used"}
        with self.assertRaisesRegex(executor.Blocked, "checkout Markdown"):
            executor.validate_manifest_paths(manifest)

    def test_source_or_context_drift_blocks_before_fixture_access(self):
        write_new(self.directory / "manifest.json", self.manifest())
        with patch.object(executor, "verify_manifest", side_effect=ValueError("source/fixture/schema drift")), \
                patch.object(executor, "fixture_files", side_effect=AssertionError("not reached")), \
                patch("builtins.print"):
            self.assertEqual(executor.main([str(self.directory), "--out", str(self.base / "evidence")]), 2)
        result = executor.load(self.base / "evidence/blocker.json")
        self.assertEqual(result["blockers"], ["source/fixture/schema drift"])

    def run_fixture(self, code, timeout=2):
        return executor.bounded_command([sys.executable, "-c", code], self.base,
                                        executor.native_env(os.environ, {}, self.base),
                                        self.base / "stdout", self.base / "stderr", timeout)

    def test_command_keeps_raw_logs_and_records_measured_failure(self):
        result = self.run_fixture("import sys; print('raw stdout'); print('raw stderr', file=sys.stderr); sys.exit(7)")
        self.assertEqual(result["exit_code"], 7)
        self.assertFalse(result["timeout"])
        self.assertGreater(result["duration_s"], 0)
        self.assertEqual((self.base / "stdout").read_bytes(), b"raw stdout\n")
        self.assertEqual((self.base / "stderr").read_bytes(), b"raw stderr\n")

    def test_timeout_kills_ignoring_parent_and_grandchild(self):
        code = ("import os, signal, time\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "child = os.fork()\n"
                "if child == 0:\n"
                " time.sleep(0.8)\n"
                " open('escaped-marker', 'w').write('alive')\n"
                "else:\n"
                " open('child-pid', 'w').write(str(child))\n"
                " time.sleep(20)\n")
        result = self.run_fixture(code, timeout=0.4)
        self.assertTrue(result["timeout"])
        self.assertEqual(result["exit_code"], -signal.SIGKILL)
        self.assertGreaterEqual(result["duration_s"], 0.4)
        self.assertLess(result["duration_s"], 6)
        self.assertTrue((self.base / "child-pid").exists())
        time.sleep(0.6)
        self.assertFalse((self.base / "escaped-marker").exists())

    def test_success_also_cleans_lingering_group_members(self):
        code = ("import os, time\n"
                "if os.fork() == 0:\n"
                " time.sleep(0.4)\n"
                " open('escaped-marker', 'w').write('alive')\n"
                "else: os._exit(0)\n")
        result = self.run_fixture(code)
        self.assertEqual(result["exit_code"], 0)
        time.sleep(0.6)
        self.assertFalse((self.base / "escaped-marker").exists())

    def test_runner_rejects_shell_text_invalid_deadlines_and_log_overwrite(self):
        with self.assertRaises(ValueError):
            executor.bounded_command("echo unsafe", self.base, {}, self.base / "o", self.base / "e", 1)
        for value in (0, -1, True, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                executor.bounded_command(["never"], self.base, {}, self.base / "o", self.base / "e", value)
        self.run_fixture("print('original')")
        with self.assertRaises(FileExistsError):
            self.run_fixture("print('replacement')")
        self.assertEqual((self.base / "stdout").read_bytes(), b"original\n")


if __name__ == "__main__":
    unittest.main()
