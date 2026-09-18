import sys
import hashlib
import json
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cynthia_phase_evidence as evidence


def receipt():
    return {"phase": "A", "planner": "astra", "executor": "luna", "auditor": "opus-5", "files": [], "commands": [], "tests": [], "verdict": "PASS", "risks": []}


class PhaseEvidenceTests(unittest.TestCase):
    def test_required_model_roles_and_evidence_are_enforced(self):
        evidence.validate(receipt())
        bad = receipt(); bad["auditor"] = "terra"
        with self.assertRaisesRegex(ValueError, "opus-5"):
            evidence.validate(bad)

    def test_independent_opus_audit_uses_its_own_attestation_contract(self):
        audited = {"artifact": "cynthia_independent_audit_receipt", "auditor": "opus-5"}
        audited["signature"] = {"algorithm": "sha256", "body_sha256": hashlib.sha256(json.dumps(audited, sort_keys=True, separators=(",", ":")).encode()).hexdigest()}
        evidence.validate(audited)
        bad = receipt(); del bad["risks"]
        with self.assertRaisesRegex(ValueError, "risks"):
            evidence.validate(bad)


if __name__ == "__main__":
    unittest.main()
