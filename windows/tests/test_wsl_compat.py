"""Exercise the unmodified Data Brain scripts through the WSL compatibility layer."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[2]


class WslCompatibilityTests(unittest.TestCase):
    def test_original_index_and_fts_scripts_run_with_windows_shims(self):
        with tempfile.TemporaryDirectory() as temporary:
            temporary_root = Path(temporary)
            checkout = temporary_root / "data-brain"
            notes = temporary_root / "notes"
            notes.mkdir()
            (notes / "launch.md").write_text(
                "---\ntheme: work\ntags: [launch, test]\n---\nWSL launch checklist\n",
                encoding="utf-8",
            )
            shutil.copytree(SOURCE, checkout, ignore=shutil.ignore_patterns(".git", "moc"))
            canon = checkout / "bin" / "canon.sh"
            canon.write_text(canon.read_text(encoding="utf-8").replace('$HOME/Notes', str(notes)), encoding="utf-8")
            environment = os.environ | {"PATH": f"{checkout / 'windows' / 'shims'}:{os.environ['PATH']}"}
            for command in ("build-index.sh", "build-fts.sh"):
                completed = subprocess.run(
                    ["bash", str(checkout / "bin" / command)], text=True, capture_output=True,
                    env=environment, check=False,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
            results = subprocess.run(
                ["bash", str(checkout / "bin" / "fts.sh"), "launch"], text=True,
                capture_output=True, env=environment, check=False,
            )
            self.assertEqual(results.returncode, 0, results.stderr)
            self.assertIn("launch.md", results.stdout)


if __name__ == "__main__":
    unittest.main()
