"""Run the shared engine scripts on Linux (as on Windows WSL 2): bin/compat.sh must load by itself."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[2] / "macOS"  # the shared engine


class WslCompatibilityTests(unittest.TestCase):
    def test_index_fts_and_recent_run_directly_on_linux(self):
        with tempfile.TemporaryDirectory() as temporary:
            temporary_root = Path(temporary)
            checkout = temporary_root / "data-brain"
            notes = temporary_root / "notes"
            notes.mkdir()
            canonical_notes = notes.resolve()
            (notes / "launch.md").write_text(
                "---\ntheme: work\ntags: [launch, test]\n---\nWSL launch checklist\n",
                encoding="utf-8",
            )
            shutil.copytree(SOURCE, checkout, ignore=shutil.ignore_patterns(".git", "moc"))
            canon = checkout / "bin" / "canon.sh"
            canon.write_text(canon.read_text(encoding="utf-8").replace('$HOME/Notes', str(canonical_notes)), encoding="utf-8")
            environment = dict(os.environ)  # no PATH tweak: scripts called directly, as Claude does
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
            # recent.sh printed nothing on WSL before bin/compat (BSD stat -f / date -r).
            recent = subprocess.run(
                ["bash", str(checkout / "bin" / "recent.sh"), "5"], text=True,
                capture_output=True, env=environment, check=False,
            )
            self.assertEqual(recent.returncode, 0, recent.stderr)
            self.assertIn("launch.md", recent.stdout)


if __name__ == "__main__":
    unittest.main()
