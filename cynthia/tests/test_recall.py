import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cynthia_recall as recall


def exam():
    queries = []
    for stratum, count in recall.DENOMINATORS.items():
        for number in range(count):
            queries.append({"id": f"{stratum}-{number}", "stratum": stratum, "expected_paths": [f"/{stratum}/{number}"], "trap": False})
    queries.append({"id": "trap-1", "stratum": "TRAP", "expected_paths": [], "trap": True})
    return {"corpus_generation": "synthetic-generation", "denominators": recall.DENOMINATORS, "queries": queries}


def results(fixture):
    return {"corpus_generation": fixture["corpus_generation"], "results": [
        {"id": query["id"], "abstained": query["trap"], "ranked_paths": [] if query["trap"] else query["expected_paths"]}
        for query in fixture["queries"]
    ]}


class RecallTests(unittest.TestCase):
    def test_exact_denominators_and_valid_trap_pass(self):
        fixture = exam()
        report = recall.evaluate(fixture, results(fixture))
        self.assertEqual(report["status"], "PASS")
        self.assertEqual(report["strata"]["Hard"]["denominator"], 40)

    def test_missing_result_or_generation_mismatch_blocks(self):
        fixture = exam()
        broken = results(fixture)
        broken["results"].pop()
        with self.assertRaisesRegex(ValueError, "exactly"):
            recall.evaluate(fixture, broken)
        broken = results(fixture)
        broken["corpus_generation"] = "changed"
        with self.assertRaisesRegex(ValueError, "generation mismatch"):
            recall.evaluate(fixture, broken)

    def test_trap_does_not_change_denominator_and_must_abstain(self):
        fixture = exam()
        output = results(fixture)
        output["results"][-1]["abstained"] = False
        self.assertEqual(recall.evaluate(fixture, output)["status"], "FAIL")

    def test_aggregate_receipt_keeps_raw_paths_outside_cynthia(self):
        fixture = {"kind": "newbrain_eval_v3_aggregate", "run_name": "pool-gateon"}
        result = {"kind": "newbrain_eval_v3_aggregate", "run_name": "pool-gateon", "inputs_sha256": {name: "a" * 64 for name in ("queries", "labels", "run", "flags", "scorer", "rule")}, "strata": {name: {"hits": count, "denominator": count} for name, count in recall.DENOMINATORS.items()}, "traps": {"valid_traps": 15, "honest_abstentions": 15}, "privacy": {"raw_paths_returned": False}}
        self.assertEqual(recall.evaluate(fixture, result)["status"], "PASS")


if __name__ == "__main__":
    unittest.main()
