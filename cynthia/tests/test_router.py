import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cynthia_router as router


def task(**changes):
    base = dict(task_id="fixture", workload="research", data_class="non_personal", required_context=("task", "source"))
    base.update(changes)
    return router.Task(**base)


class RoutingPolicyTests(unittest.TestCase):
    def test_terra_always_orchestrates(self):
        self.assertEqual(router.choose(task()).orchestrator, "terra")

    def test_private_and_unclassified_content_never_reaches_third_party(self):
        for data_class in ("mel_content", "private", "sensitive", "unknown"):
            decision = router.choose(task(data_class=data_class, bulk=True))
            self.assertEqual((decision.provider, decision.model), ("codex", "luna"))
            self.assertNotIn(decision.provider, router.THIRD_PARTY)

    def test_writing_requires_explicit_approval_before_route_selection(self):
        blocked = router.choose(task(workload="writing"))
        allowed = router.choose(task(workload="writing", approved=True))
        self.assertEqual(blocked.status, "approval_required")
        self.assertEqual((allowed.provider, allowed.model), ("codex", "luna"))

    def test_public_and_bulk_work_remain_native_even_with_claimed_route_evidence(self):
        claimed = ({"route": "external", "pass_fail": "pass"},)
        for candidate in (task(), task(workload="augmentation", bulk=True)):
            decision = router.choose(candidate, claimed)
            self.assertEqual((decision.provider, decision.model), ("codex", "luna"))
            self.assertEqual(decision.status, "native_only")

    def test_only_confidence_set_can_grade(self):
        decision = router.choose(task(protected_measurement=True))
        self.assertEqual(decision.status, "requires_dual_confidence_grade")
        self.assertNotIn("luna", router.CONFIDENCE_MODELS)
        self.assertNotIn("gemini", router.CONFIDENCE_MODELS)

    def test_handoff_must_be_complete(self):
        with self.assertRaisesRegex(ValueError, "handoff incomplete"):
            router.assert_handoff(("task", "instruction"), ("task",))


    def test_switch_needs_all_three_safety_conditions(self):
        self.assertEqual(router.can_switch(cheaper=True, same_result=True, edge_case=False), (True, "eligible"))
        self.assertEqual(router.can_switch(cheaper=False, same_result=True, edge_case=False), (False, "not_cheaper"))
        self.assertEqual(router.can_switch(cheaper=True, same_result=False, edge_case=False), (False, "result_not_equivalent"))
        self.assertEqual(router.can_switch(cheaper=True, same_result=True, edge_case=True), (False, "edge_case"))

    def test_telemetry_refuses_prompt_bodies_and_secrets(self):
        original = router.LOG
        with tempfile.TemporaryDirectory() as directory:
            router.LOG = Path(directory) / "routing.jsonl"
            router.log_event({"task_class": "M0", "pass_fail": "pass"})
            record = json.loads(router.LOG.read_text().strip())
            self.assertEqual(record["task_class"], "M0")
            with self.assertRaisesRegex(ValueError, "telemetry refuses"):
                router.log_event({"prompt": "never store this"})
            with self.assertRaisesRegex(ValueError, "unknown fields"):
                router.log_event({"private_path_alias": "never store this"})
            with self.assertRaisesRegex(ValueError, "nested values"):
                router.log_event({"task_class": {"body": "never store this"}})
        router.LOG = original



if __name__ == "__main__":
    unittest.main()
