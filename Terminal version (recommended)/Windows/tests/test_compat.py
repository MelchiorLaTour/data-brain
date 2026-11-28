"""bin/compat/{stat,date,shasum} on real Linux: the BSD forms bin/ uses must give the right values."""
import os
from pathlib import Path
import platform
import subprocess
import tempfile
import unittest

COMPAT = Path(__file__).resolve().parents[2] / "macOS" / "bin" / "compat"


def run(tool, *args, stdin=None):
    return subprocess.run(["bash", str(COMPAT / tool), *args], input=stdin, text=True,
                          capture_output=True, check=True).stdout


@unittest.skipUnless(platform.system() == "Linux", "Linux / WSL only")
class CompatTests(unittest.TestCase):
    def test_stat_formats(self):
        with tempfile.TemporaryDirectory() as temporary:
            a = Path(temporary) / "file with spaces.md"
            b = Path(temporary) / "b.md"
            a.write_text("fixture", encoding="utf-8")
            b.write_text("x", encoding="utf-8")
            os.chmod(b, 0o640)
            info = a.stat()
            self.assertEqual(run("stat", "-f", "%m", str(a)).strip(), str(int(info.st_mtime)))
            self.assertEqual(run("stat", "-f", "%z", str(a)).strip(), str(info.st_size))
            self.assertEqual(run("stat", "-f", "%i:%z:%m:%c", str(a)).strip(),
                             f"{info.st_ino}:{info.st_size}:{int(info.st_mtime)}:{int(info.st_ctime)}")
            d = Path(temporary).stat()
            self.assertEqual(run("stat", "-f", "%d:%i", temporary).strip(), f"{d.st_dev}:{d.st_ino}")
            self.assertEqual(run("stat", "-f", "%Lp", str(b)).strip(), "640")
            self.assertEqual(run("stat", "-f", "%Sf %N", str(a)).strip(), f"- {a}")
            # many files in one call, as `xargs stat` does
            self.assertEqual(run("stat", "-f", "%Sf%t%N", str(a), str(b)), f"-\t{a}\n-\t{b}\n")
            # an open descriptor describes the file, not the /dev/fd link
            with open(b) as handle:
                fd_out = subprocess.run(["bash", "-c", f'exec 9<"{b}"; bash "{COMPAT}/stat" -f "%i:%z" /dev/fd/9'],
                                        text=True, capture_output=True, check=True).stdout.strip()
            self.assertEqual(fd_out, f"{b.stat().st_ino}:{b.stat().st_size}")
            missing = subprocess.run(["bash", str(COMPAT / "stat"), "-f", "%m", str(Path(temporary) / "nope")],
                                     text=True, capture_output=True)
            self.assertNotEqual(missing.returncode, 0)
            self.assertEqual(missing.stdout, "")

    def test_date_and_shasum(self):
        self.assertEqual(run("date", "-r", "0", "+%Y").strip(),
                         subprocess.check_output(["date", "-d", "@0", "+%Y"], text=True).strip())
        expected = subprocess.check_output(["sha1sum"], input="path/x", text=True)
        self.assertEqual(run("shasum", stdin="path/x"), expected)


if __name__ == "__main__":
    unittest.main()
