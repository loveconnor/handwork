"""Fresh collector scenarios, separate from legacy scoring and native holdout claims."""
import json
import unittest
from pathlib import Path

import accounting
import run
import study
from test_study import trace


class FreshCollectorRecoveryTests(unittest.TestCase):
    def test_prospective_native_holdout_is_separate_and_unscored(self):
        protocol = json.loads(Path(__file__).with_name("heldout-protocol.json").read_text())
        self.assertFalse(protocol["scored_with_legacy_six"])
        self.assertEqual(len(protocol["cases"]), 4)
        self.assertTrue(set(case["id"] for case in protocol["cases"]).isdisjoint(study.TASKS))
        self.assertTrue(all(case["native_oracle"] and case["offline_collector_oracle"]
                            for case in protocol["cases"]))

    def test_completion_order_is_not_child_result_identity(self):
        a, b = trace(101, child=7).splitlines(), trace(102, child=8).splitlines()
        text = "\n".join([*a[:2], *b[:2], b[2], a[2]])
        result = accounting.reconcile(text)
        self.assertTrue(result["eligible"])
        self.assertEqual(result["child_usage"]["input"], 200)
        self.assertEqual(result["root_usage"]["input"], 0)

    def test_cancelled_child_never_becomes_free_work(self):
        result = accounting.reconcile(trace() + trace(2, child=8, status="transport_failed",
                                                       input_known="false", output_known="false",
                                                       cache_known="false", input=0, output=0, cached=0))
        self.assertFalse(result["eligible"])
        self.assertIsNone(result["usage"])
        self.assertEqual(result["admitted_requests"], 2)

    def test_partial_recovery_preserves_missing_terminal(self):
        interrupted = "\n".join(trace(2, child=8).splitlines()[:2])
        result = accounting.reconcile(trace() + interrupted)
        self.assertFalse(result["eligible"])
        self.assertIn("starts and terminals differ", result["errors"])


if __name__ == "__main__":
    unittest.main()
