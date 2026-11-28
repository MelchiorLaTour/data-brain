#!/usr/bin/env bash
# test_linux_compat.sh — bin/compat/{stat,date,shasum} must give Linux (Windows WSL 2) the same
# answers macOS gives for every BSD form the bin/ scripts use.
# Runs on a Mac: BSD /usr/bin/stat is the reference, Homebrew GNU coreutils (gstat, gdate,
# gsha1sum) stand in for Linux. Needs: brew install coreutils.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
C="$ROOT/bin/compat"
for t in gstat gdate gsha1sum; do command -v "$t" >/dev/null || { echo "SKIP: $t missing (brew install coreutils)"; exit 0; }; done
export NB_TEST_STAT="$(command -v gstat)" NB_TEST_DATE="$(command -v gdate)" NB_TEST_SHA1SUM="$(command -v gsha1sum)"

fail=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; echo "  mac:   $2"; echo "  linux: $3"; fail=1; fi; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
printf 'hello\n' > "$tmp/a b.md"; printf 'x\n' > "$tmp/c.md"; chmod 640 "$tmp/c.md"

# Every single-file format in bin/ (grep -oh "stat -f '...'" bin/*.sh).
for fmt in '%m' '%z' '%z:%m' '%i:%z:%m:%c' '%d:%i' '%Lp' '%Sf' '%Sf %N' '%Sf%t%N' '%z:%m%t%N'; do
  check "stat -f '$fmt'" "$(/usr/bin/stat -f "$fmt" "$tmp/a b.md")" "$("$C/stat" -f "$fmt" "$tmp/a b.md")"
done
check "stat -f '%Lp' (640)" "$(/usr/bin/stat -f '%Lp' "$tmp/c.md")" "$("$C/stat" -f '%Lp' "$tmp/c.md")"
check "stat -f '%d:%i' on a directory" "$(/usr/bin/stat -f '%d:%i' "$tmp")" "$("$C/stat" -f '%d:%i' "$tmp")"

# Many files in one call, as xargs does in canon.sh / build-fts.sh / search.sh.
check "xargs stat -f '%Sf%t%N' (2 files)" \
  "$(printf '%s\0' "$tmp/a b.md" "$tmp/c.md" | xargs -0 /usr/bin/stat -f '%Sf%t%N')" \
  "$(printf '%s\0' "$tmp/a b.md" "$tmp/c.md" | xargs -0 "$C/stat" -f '%Sf%t%N')"

# The open-descriptor form canon.sh uses (stat of /dev/fd/9 must describe the FILE, not the link).
check "stat -f '%i:%z:%m:%c' /dev/fd/9" \
  "$(exec 9<"$tmp/c.md"; /usr/bin/stat -f '%i:%z:%m:%c' /dev/fd/9)" \
  "$(exec 9<"$tmp/c.md"; "$C/stat" -f '%i:%z:%m:%c' /dev/fd/9)"

# %p is only a change fingerprint (build-fts.sh): it must exist and change when permissions change.
p1="$("$C/stat" -f '%p' "$tmp/c.md")"; chmod 600 "$tmp/c.md"; p2="$("$C/stat" -f '%p' "$tmp/c.md")"
[ -n "$p1" ] && [ "$p1" != "$p2" ] && echo "ok   stat -f '%p' changes with chmod" || { echo "FAIL stat -f '%p' ($p1 / $p2)"; fail=1; }

# Missing file: no output on stdout, non-zero exit, same as macOS (scripts rely on "|| echo 0").
out="$("$C/stat" -f '%m' "$tmp/missing" 2>/dev/null)"; rc=$?
[ -z "$out" ] && [ "$rc" -ne 0 ] && echo "ok   missing file fails quietly" || { echo "FAIL missing file (rc=$rc out=$out)"; fail=1; }

check "date -r EPOCH '+%Y-%m-%d'" "$(/bin/date -r 1700000000 '+%Y-%m-%d')" "$("$C/date" -r 1700000000 '+%Y-%m-%d')"
check "date +%s passes through" "$(/bin/date +%Y)" "$("$C/date" +%Y)"

check "shasum (sha1sum fallback)" "$(printf 'path/x' | shasum)" "$(printf 'path/x' | NB_TEST_NO_SHASUM=1 "$C/shasum")"

# End to end: recent.sh under the Linux translators gives the same list as on macOS.
fx="$tmp/brain"; mkdir -p "$fx/bin" "$fx/moc"
cp "$ROOT/bin/recent.sh" "$ROOT/bin/compat.sh" "$fx/bin/"; cp -R "$C" "$fx/bin/compat"
printf '%s\t%s\t\t\n' "$tmp/a b.md" "Note A" "$tmp/c.md" "Note C" > "$fx/moc/index.tsv"
touch -t 202001020304 "$tmp/a b.md"
mac="$(bash "$fx/bin/recent.sh" 5)"
linux="$(PATH="$C:$PATH" bash "$fx/bin/recent.sh" 5)"
check "recent.sh output" "$mac" "$linux"

[ "$fail" -eq 0 ] && echo "PASS test_linux_compat" || { echo "FAILED test_linux_compat"; exit 1; }
