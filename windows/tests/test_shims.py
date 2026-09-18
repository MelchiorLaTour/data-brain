import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SHIMS = Path(__file__).resolve().parents[1] / "shims"


class ShimTests(unittest.TestCase):
    def test_bsd_stat_and_date_forms_have_wsl_safe_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "file with spaces.txt"
            path.write_text("fixture", encoding="utf-8")
            stat = [sys.executable, str(SHIMS / "stat")]
            epoch = subprocess.check_output([*stat, "-f", "%m", str(path)], text=True).strip()
            self.assertTrue(epoch.isdigit())
            flags_and_path = subprocess.check_output([*stat, "-f", "%Sf %N", str(path)], text=True).strip()
            self.assertTrue(flags_and_path.endswith(str(path)))
            rendered = subprocess.check_output([sys.executable, str(SHIMS / "date"), "-r", epoch, "+%Y"], text=True).strip()
            self.assertEqual(len(rendered), 4)


if __name__ == "__main__":
    unittest.main()
