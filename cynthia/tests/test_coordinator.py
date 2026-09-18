import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cynthia_coordinator as coordinator


class CoordinatorTests(unittest.TestCase):
    def write_manifest(self, root: Path, *, context=None, sectors=None, newbrain=None):
        (root / "CLAUDE.md").write_text("synthetic instructions\n", encoding="utf-8")
        (root / "recall.json").write_text('{"query": "synthetic"}\n', encoding="utf-8")
        manifest = {
            "schema_version": 1,
            "project_id": "test-project",
            "project_root": ".",
            "context": context if context is not None else [{"name": "instructions", "path": "CLAUDE.md", "required": True}],
            "required_files": [],
            "sectors": sectors or [],
            "newbrain": newbrain,
            "refresh_command": None if newbrain is None else ["refresh-newbrain"],
            "setup_commands": [],
            "recall_fixture": "recall.json",
            "allowed_routes": ["luna"],
            "data_class": "synthetic",
            "approvals": {"required": False},
            "receipt_fields": ["status", "issues", "states"],
        }
        path = root / "context.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        return path

    def test_clean_manifest_passes_and_discloses_digest_reads(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            receipt = coordinator.inspect_manifest(self.write_manifest(root))
            self.assertEqual(receipt["status"], "PASS")
            self.assertTrue(receipt["privacy"]["file_bytes_read_for_sha256"])
            self.assertFalse(receipt["privacy"]["context_bodies_transmitted"])
            self.assertEqual(receipt["states"]["configured"], "PASS")
            self.assertEqual(receipt["states"]["loaded"], "PASS")
            self.assertEqual(receipt["states"]["tested"], "NOT_RUN")
            self.assertEqual(receipt["states"]["ready"], "BLOCKED")
            self.assertEqual(len(receipt["context_proofs"]), 1)

    def test_missing_required_context_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.write_manifest(root, context=[{"name": "missing", "path": "nope.md", "required": True}])
            receipt = coordinator.inspect_manifest(path)
            self.assertEqual(receipt["status"], "BLOCKED")
            self.assertIn("missing:missing_source", receipt["issues"])

    def test_stale_context_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = [{"name": "instructions", "path": "CLAUDE.md", "required": True, "max_age_seconds": 1}]
            path = self.write_manifest(root, context=context)
            old = time.time() - 10
            os.utime(root / "CLAUDE.md", (old, old))
            receipt = coordinator.inspect_manifest(path)
            self.assertEqual(receipt["status"], "BLOCKED")
            self.assertIn("instructions:stale_source", receipt["issues"])

    def test_invented_or_changed_handoff_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.write_manifest(root)
            receipt = coordinator.inspect_manifest(path)
            proof = receipt["context_proofs"][0]
            proof["sha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "hash_mismatch"):
                coordinator.assert_handoff(receipt["context_proofs"], [proof])
            with self.assertRaisesRegex(ValueError, "missing:invented"):
                coordinator.assert_handoff(["invented"], receipt["context_proofs"])

    def test_handoff_detects_source_changed_after_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.write_manifest(root)
            receipt = coordinator.inspect_manifest(path)
            proof = receipt["context_proofs"]
            (root / "CLAUDE.md").write_text("changed\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "hash_mismatch|changed_since_handoff"):
                coordinator.assert_handoff(proof, proof)

    def test_newbrain_freshness_marker_is_checked_without_reading_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            brain = root / "brain"
            (brain / "moc").mkdir(parents=True)
            (brain / "moc" / "fts.db").write_bytes(b"synthetic marker")
            manifest = self.write_manifest(root, newbrain={"root": str(brain), "freshness_file": "moc/fts.db", "max_age_seconds": 86400, "required": True})
            receipt = coordinator.inspect_manifest(manifest)
            self.assertEqual(receipt["status"], "PASS")
            self.assertFalse(receipt["privacy"]["context_bodies_transmitted"])

    def test_empty_context_is_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.write_manifest(root, context=[])
            receipt = coordinator.inspect_manifest(path)
            self.assertEqual(receipt["status"], "BLOCKED")
            self.assertIn("non-empty", receipt["issues"][0])
            self.assertEqual(receipt["states"]["configured"], "BLOCKED")

    def test_false_or_malformed_context_is_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.write_manifest(root, context=False)
            receipt = coordinator.inspect_manifest(path)
            self.assertEqual(receipt["status"], "BLOCKED")
            self.assertIn("context", receipt["issues"][0])

    def test_manifest_missing_universal_field_is_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.write_manifest(root)
            manifest = json.loads(path.read_text(encoding="utf-8"))
            del manifest["allowed_routes"]
            path.write_text(json.dumps(manifest), encoding="utf-8")
            receipt = coordinator.inspect_manifest(path)
            self.assertEqual(receipt["status"], "BLOCKED")
            self.assertIn("allowed_routes", receipt["issues"][0])

    def test_shell_command_strings_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.write_manifest(root)
            manifest = json.loads(path.read_text(encoding="utf-8"))
            manifest["setup_commands"] = ["python3 setup.py"]
            path.write_text(json.dumps(manifest), encoding="utf-8")
            receipt = coordinator.inspect_manifest(path)
            self.assertEqual(receipt["status"], "BLOCKED")
            self.assertIn("argv", receipt["issues"][0])

    def test_declared_required_file_must_resolve_even_if_marked_optional(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.write_manifest(root)
            manifest = json.loads(path.read_text(encoding="utf-8"))
            manifest["required_files"] = [{"name": "missing", "path": "missing.md", "required": False}]
            path.write_text(json.dumps(manifest), encoding="utf-8")
            receipt = coordinator.inspect_manifest(path)
            self.assertEqual(receipt["status"], "BLOCKED")
            self.assertIn("required_file:missing:missing_source", receipt["issues"])

    def test_declared_sector_source_must_resolve(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = self.write_manifest(root, sectors=[{"name": "coding", "source": "missing-sector.md"}])
            receipt = coordinator.inspect_manifest(path)
            self.assertEqual(receipt["status"], "BLOCKED")
            self.assertIn("sector:coding:missing_source", receipt["issues"])

    def test_stale_newbrain_freshness_blocks_and_is_not_refreshed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            brain = root / "brain"
            (brain / "moc").mkdir(parents=True)
            marker = brain / "moc" / "fts.db"
            marker.write_bytes(b"synthetic marker")
            path = self.write_manifest(root, newbrain={"root": str(brain), "freshness_file": "moc/fts.db", "max_age_seconds": 1})
            old = time.time() - 10
            os.utime(marker, (old, old))
            receipt = coordinator.inspect_manifest(path)
            self.assertEqual(receipt["status"], "BLOCKED")
            self.assertEqual(receipt["states"]["refreshed"], "BLOCKED")
            self.assertIn("newbrain:stale_source", receipt["issues"])


if __name__ == "__main__":
    unittest.main()
