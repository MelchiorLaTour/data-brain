import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cynthia_setup as setup


class SetupTests(unittest.TestCase):
    def manifest(self, root: Path) -> Path:
        (root / "CLAUDE.md").write_text("synthetic\n", encoding="utf-8")
        (root / "recall.json").write_text("{}\n", encoding="utf-8")
        payload = {
            "schema_version": 1, "project_id": "synthetic", "project_root": ".",
            "context": [{"name": "instructions", "path": "CLAUDE.md"}],
            "required_files": [], "sectors": [], "newbrain": None,
            "refresh_command": None, "setup_commands": [], "recall_fixture": "recall.json",
            "allowed_routes": ["codex-luna"], "data_class": "synthetic",
            "approvals": {}, "receipt_fields": ["status"],
        }
        path = root / "manifest.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def test_setup_is_local_only_and_runs_tests_after_valid_preflight(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(setup, "_run", return_value={"status": "PASS", "exit_code": 0, "command": [], "stdout": "", "stderr": ""}) as run:
                receipt = setup.setup(self.manifest(Path(temporary)))
            self.assertEqual(receipt["status"], "BLOCKED")
            self.assertFalse(receipt["external_requests"])
            self.assertFalse(receipt["refresh_executed"])
            self.assertEqual(run.call_count, 5)
            self.assertEqual(receipt["steps"]["project"]["status"], "PASS")
            self.assertEqual(receipt["steps"]["route"]["status"], "native_only")
            self.assertEqual(receipt["steps"]["recall"]["status"], "NOT_RUN")
            self.assertEqual([item["suite"] for item in receipt["steps"]["tests"]], [
                "cynthia", "lifecycle", "inventory", "relationships", "migration",
            ])

    def test_invalid_manifest_blocks_without_running_tests(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = self.manifest(Path(temporary))
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["context"] = []
            path.write_text(json.dumps(payload), encoding="utf-8")
            with patch.object(setup, "_run") as run:
                with self.assertRaises(ValueError):
                    setup.setup(path)
            run.assert_not_called()

    def test_refresh_requires_manifest_approval(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = self.manifest(root)
            payload = json.loads(path.read_text(encoding="utf-8"))
            brain = root / "brain" / "moc"
            brain.mkdir(parents=True)
            (brain / "fts.db").write_bytes(b"fresh")
            payload.update({
                "newbrain": {"root": str(root / "brain"), "freshness_file": "moc/fts.db", "max_age_seconds": 86400},
                "refresh_command": ["/bin/true"],
            })
            path.write_text(json.dumps(payload), encoding="utf-8")
            with patch.object(setup, "_run") as run:
                receipt = setup.setup(path, refresh=True)
            self.assertEqual(receipt["steps"]["refresh"]["status"], "BLOCKED")
            run.assert_not_called()

    def test_writing_route_requires_manifest_approval(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = self.manifest(Path(temporary))
            with patch.object(setup, "_run", return_value={"status": "PASS", "exit_code": 0, "command": [], "stdout": "", "stderr": ""}):
                receipt = setup.setup(path, workload="writing")
            self.assertEqual(receipt["steps"]["route"]["status"], "approval_required")

    def test_writing_route_accepts_explicit_manifest_approval(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = self.manifest(root)
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["approvals"] = {"writing": "approved"}
            path.write_text(json.dumps(payload), encoding="utf-8")
            with patch.object(setup, "_run", return_value={"status": "PASS", "exit_code": 0, "command": [], "stdout": "", "stderr": ""}):
                receipt = setup.setup(path, workload="writing")
            self.assertEqual(receipt["steps"]["route"]["status"], "native_only")

    def test_approved_refresh_runs_argv_then_rechecks_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = self.manifest(root)
            payload = json.loads(path.read_text(encoding="utf-8"))
            brain = root / "brain" / "moc"
            brain.mkdir(parents=True)
            (brain / "fts.db").write_bytes(b"fresh")
            payload.update({
                "newbrain": {"root": str(root / "brain"), "freshness_file": "moc/fts.db", "max_age_seconds": 86400},
                "refresh_command": ["/bin/true"],
                "approvals": {"newbrain_refresh": "approved"},
            })
            path.write_text(json.dumps(payload), encoding="utf-8")
            result = {"status": "PASS", "exit_code": 0, "command": [], "stdout": "", "stderr": ""}
            with patch.object(setup, "_run", return_value=result) as run:
                receipt = setup.setup(path, refresh=True)
            self.assertTrue(receipt["refresh_executed"])
            self.assertEqual(receipt["steps"]["refresh"]["status"], "PASS")
            self.assertEqual(run.call_args_list[0].args[0], ["/bin/true"])


if __name__ == "__main__":
    unittest.main()
