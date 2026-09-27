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
            fingerprint = subprocess.check_output([*stat, "-f", "%z:%m:%c", str(path)], text=True).strip()
            size, mtime, ctime = fingerprint.split(":")
            self.assertEqual(size, str(path.stat().st_size))
            self.assertTrue(mtime.isdigit())
            self.assertTrue(ctime.isdigit())
            identity_fingerprint = subprocess.check_output(
                [*stat, "-f", "%i:%z:%m:%c", str(path)], text=True
            ).strip()
            inode, size, mtime, ctime = identity_fingerprint.split(":")
            self.assertEqual(inode, str(path.stat().st_ino))
            self.assertEqual(size, str(path.stat().st_size))
            self.assertTrue(mtime.isdigit())
            self.assertTrue(ctime.isdigit())
            directory_identity = subprocess.check_output(
                [*stat, "-f", "%d:%i", str(path.parent)], text=True
            ).strip()
            device, inode = directory_identity.split(":")
            self.assertEqual(device, str(path.parent.stat().st_dev))
            self.assertEqual(inode, str(path.parent.stat().st_ino))
            flags_and_path = subprocess.check_output([*stat, "-f", "%Sf %N", str(path)], text=True).strip()
            self.assertTrue(flags_and_path.endswith(str(path)))
            rendered = subprocess.check_output([sys.executable, str(SHIMS / "date"), "-r", epoch, "+%Y"], text=True).strip()
            self.assertEqual(len(rendered), 4)


if __name__ == "__main__":
    unittest.main()
