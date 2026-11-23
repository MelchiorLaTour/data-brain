#!/usr/bin/env bash
# An online-only file that was never indexed is downloaded first and fingerprinted after: macOS changes a file's ctime when it downloads it,
# so a fingerprint taken before the download made every such file fail as source_changed_during_copy. Download is simulated by a stub `cat`
# that bumps the target's ctime on its first read. A file that REALLY changes while it is copied (online-only or local) must still fail.
# Fake files and a fake HOME-free scratch folder only.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-extract-ctime.XXXXXX")"
trap 'chmod -R u+rw "$SCRATCH" 2>/dev/null; rm -rf "$SCRATCH"' EXIT
root="$SCRATCH/root"; moc="$SCRATCH/brain/moc"; bin="$SCRATCH/bin"
mkdir -p "$root" "$moc/extracted" "$bin"; root="$(cd "$root" && pwd -P)"
printf '%s\n' "$root" > "$SCRATCH/roots.txt"
cat > "$bin/pdftotext" <<'SH'
#!/bin/bash
echo "readable words here for $(basename "$2")"
SH
cat > "$bin/brctl" <<'SH'
#!/bin/bash
exit 0
SH
cat > "$bin/cat" <<'SH'
#!/bin/bash
# Stub of a File Provider: the first read of CTIME_TARGET changes its ctime (the download); every read of an APPEND_TARGETS file changes its size.
is_target() { # $1 = candidate target path; true when any argument names it (by path, or via /dev/fd/9 pointing at the same inode)
  local a
  for a in "${@:2}"; do
    [ "$a" = "$1" ] && return 0
    [ "$a" = /dev/fd/9 ] && [ "$(/usr/bin/stat -f %i /dev/fd/9 2>/dev/null)" = "$(/usr/bin/stat -f %i "$1" 2>/dev/null)" ] && return 0
  done
  return 1
}
if [ -n "${CTIME_TARGET:-}" ] && [ ! -e "$CTIME_FLAG" ] && is_target "$CTIME_TARGET" "$@"; then
  : > "$CTIME_FLAG"; sleep 1.1; /bin/chmod u-w "$CTIME_TARGET"; /bin/chmod u+w "$CTIME_TARGET"
fi
for t in ${APPEND_TARGETS:-}; do is_target "$t" "$@" && printf 'more\n' >> "$t"; done
exec /bin/cat "$@"
SH
chmod +x "$bin/pdftotext" "$bin/brctl" "$bin/cat"
printf 'TEXTPDF download\n' > "$root/dl.pdf"; printf 'TEXTPDF offline-changing\n' > "$root/off_change.pdf"; printf 'TEXTPDF local-changing\n' > "$root/local_change.pdf"
{ for n in dl off_change local_change; do printf '%s\t%s\t-\t-\n' "$root/$n.pdf" "$n"; done; } > "$moc/index.tsv"
printf '%s\n%s\n' "$root/dl.pdf" "$root/off_change.pdf" > "$SCRATCH/dataless.txt"
# sanity: chmod really changes the ctime on this filesystem (otherwise the simulation proves nothing)
b="$(stat -f %c "$root/dl.pdf")"; sleep 1.1; chmod u-w "$root/dl.pdf"; chmod u+w "$root/dl.pdf"; [ "$(stat -f %c "$root/dl.pdf")" != "$b" ] || { echo "FAIL: test setup: chmod did not change ctime" >&2; exit 1; }
PATH="$bin:/usr/bin:/bin" CTIME_TARGET="$root/dl.pdf" CTIME_FLAG="$SCRATCH/flag" APPEND_TARGETS="$root/off_change.pdf $root/local_change.pdf" \
  NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" NB_TEST_DATALESS_LIST="$SCRATCH/dataless.txt" \
  bash "$PROJECT_ROOT/bin/extract.sh" > "$SCRATCH/run.log" 2>&1 || { cat "$SCRATCH/run.log" >&2; echo "FAIL: extract.sh aborted" >&2; exit 1; }
rep="$moc/extract-report.tsv"
hash="$(printf '%s' "$root/dl.pdf" | shasum | cut -c1-16)"
if grep -Fq "$root/dl.pdf"$'\tsource_changed' "$rep"; then echo "FAIL: an online-only file whose ctime changed on download must still be indexed" >&2; cat "$rep" >&2; exit 1; fi
[ -s "$moc/extracted/$hash.txt" ] || { echo "FAIL: the downloaded file was not extracted" >&2; cat "$rep" >&2; exit 1; }
grep -Fq "$root/off_change.pdf"$'\tsource_changed_during_copy' "$rep" || { echo "FAIL: an online-only file that really changes during the copy must still fail" >&2; cat "$rep" >&2; exit 1; }
grep -Fq "$root/local_change.pdf"$'\tsource_changed_during_copy' "$rep" || { echo "FAIL: a local file that really changes during the copy must still fail" >&2; cat "$rep" >&2; exit 1; }
echo "PASS: an online-only file is downloaded before it is fingerprinted (ctime change on download no longer fails it); files that really change during the copy still fail."
