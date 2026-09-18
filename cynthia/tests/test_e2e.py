import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cynthia_e2e


class E2ETests(unittest.TestCase):
    def test_receipt_enumerates_all_cases_and_refuses_missing_live_gates(self):
        setup = {"status": "BLOCKED", "steps": {
            "project": {"status": "PASS"}, "route": {"provider": "codex"},
            "recall": {"status": "NOT_RUN", "reason": "missing"},
            "tests": [{"suite": name, "status": "PASS"} for name in ("cynthia", "lifecycle", "migration")],
        }}
        with patch.object(cynthia_e2e.cynthia_setup, "setup", return_value=setup):
            receipt = cynthia_e2e.run("synthetic.json")
        self.assertEqual(set(receipt["use_cases"]), set(cynthia_e2e.REQUIRED_CASES))
        self.assertEqual(receipt["status"], "BLOCKED")
        self.assertEqual(receipt["use_cases"]["recall_easy_medium_hard_xling"]["status"], "BLOCKED")
        self.assertEqual(receipt["use_cases"]["phase_0"]["status"], "BLOCKED")


if __name__ == "__main__":
    unittest.main()
