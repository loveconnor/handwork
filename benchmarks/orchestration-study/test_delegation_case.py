"""Contract and evidence checks for the separate delegation regression case."""
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import delegation_case as case
import run
import study
from test_study import records, trace


class DelegationCaseTests(unittest.TestCase):
    def test_supplemental_freeze_preserves_original_contract_and_rejects_drift(self):
        configuration = run.contracts(run.ROOT)
        original = copy.deepcopy(configuration)
        with tempfile.TemporaryDirectory() as folder, patch.object(study, "source_files", return_value={}):
            binary = Path(folder) / "binary"
            binary.write_bytes(b"synthetic offline binary")
            normal = study.freeze(run.ROOT, binary, configuration, "BOUNDED_DELEGATION")
            supplemental = study.freeze(run.ROOT, binary, configuration, "BOUNDED_DELEGATION", supplemental=True)
            study.verify_manifest(normal)
            study.verify_manifest(supplemental)
            self.assertEqual(configuration, original)
            self.assertEqual(normal["configuration"], original)
            self.assertEqual(len(normal["schedule"]), 24)
            self.assertEqual(len(supplemental["schedule"]), 4)
            self.assertEqual([row["arm"] for row in supplemental["schedule"]],
                             ["baseline", "candidate", "candidate", "baseline"])
            self.assertEqual(supplemental["configuration"]["tasks"]["queue"]["fixture_hashes"],
                             original["tasks"]["queue"]["fixture_hashes"])
            self.assertEqual(supplemental["configuration"]["tasks"]["queue"]["verifier_sha256"],
                             original["tasks"]["queue"]["verifier_sha256"])
            # Even re-signing the manifest must not permit an arbitrary case prompt/schedule/flag.
            for kind in ("prompt", "schedule", "flag"):
                changed = copy.deepcopy(supplemental)
                if kind == "prompt":
                    changed["configuration"]["tasks"]["queue"]["prompt"] += " changed"
                elif kind == "schedule":
                    changed["schedule"].reverse()
                else:
                    changed["candidate_controls"] = {"HANDWORK_EXPERIMENT_TASK_EVIDENCE": "1"}
                changed["configuration_sha256"] = study.digest(changed["configuration"])
                changed.pop("manifest_sha256")
                changed["manifest_sha256"] = study.digest(changed)
                with self.assertRaisesRegex(ValueError, "supplemental delegation"):
                    study.verify_manifest(changed)

    def test_real_admitted_child_and_delivered_policy_required_in_each_arm(self):
        for arm in ("baseline", "candidate"):
            size = 389 if arm == "candidate" else 0
            event = (f"event=bounded_delegation subagent_id=7 enabled={str(arm == 'candidate').lower()} "
                     f"available=false guidance_bytes={size} child_policy_bytes={size}\n")
            valid = trace() + trace(2, child=7) + event
            self.assertEqual(case.evidence(valid, arm), {"child_ids": ["7"], "problems": []})
            for invalid in (trace(), valid.replace("provider_admitted request_id=2", "ignored request_id=2"),
                            valid.replace("available=false", "available=true"),
                            valid.replace(f"guidance_bytes={size}", f"guidance_bytes={size + 1}"),
                            valid + trace(3, child=8), valid.replace("subagent_id=7 enabled", "subagent_id=8 enabled")):
                self.assertTrue(case.evidence(invalid, arm)["problems"])

    def test_supplemental_report_cannot_enter_six_task_denominator_or_hide_regression(self):
        rows = [row for row in records() if row["task"] == "queue"]
        manifest = {"study_kind": case.KIND, "schedule": case.schedule()}
        result = study.evaluate(manifest, rows)
        self.assertTrue(result["promote"])
        self.assertEqual(set(result["tasks"]), {"queue"})
        self.assertEqual(result["classification"], case.CLASSIFICATION)
        self.assertFalse(study.evaluate({"schedule": study.schedule()}, rows)["promote"])
        rows[0]["accounting"]["usage"]["output"] = 999
        # Explicit candidate regression, regardless of row ordering.
        for row in rows:
            if row["arm"] == "candidate":
                row["accounting"]["usage"]["input"] = 101
        self.assertFalse(study.evaluate(manifest, rows)["promote"])
