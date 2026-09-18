import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cynthia_newbrain_recall as bridge


class NewBrainRecallTests(unittest.TestCase):
    def test_bridge_returns_only_aggregate_counts_and_hashes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "runs").mkdir()
            for name in ("queries.tsv", "labels.tsv", "score.sh", "RULE.md", "runs/arm.tsv", "runs/arm.flags"):
                (root / name).write_text("fixture\n", encoding="utf-8")
            output = "\n".join((
                "v3/easy 20/20", "v3/medium 20/20", "v3/hard 36/40", "v3/xling 18/20", "TRAP HONESTY 15/15",
            ))
            with patch.object(bridge.subprocess, "run", return_value=type("Run", (), {"returncode": 0, "stdout": output})()):
                receipt = bridge.generate("arm", root=root)
        self.assertEqual(receipt["strata"]["Hard"], {"hits": 36, "denominator": 40})
        self.assertEqual(receipt["traps"]["honest_abstentions"], 15)
        self.assertFalse(receipt["privacy"]["raw_paths_returned"])
        self.assertEqual(set(receipt["inputs_sha256"]), {"queries", "labels", "run", "flags", "scorer", "rule"})


if __name__ == "__main__":
    unittest.main()
