#!/usr/bin/env bash
# A file that changes while the search index is being built must never fail the whole build (2026-10-12: one such file ended a 158 s refresh).
#   S1: the file changes during its first read only -> it is read again and the NEW text is searchable; no file is reported as left out.
#   S2: the file changes during every read -> after 3 tries only that file is left out (logged), the other file is indexed, the build succeeds,
#       and the next build (nothing changing) picks the left-out file up.
# BUILD_FTS can point at a changed copy of build-fts.sh to prove the test fails on it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BUILD="${BUILD_FTS:-$ROOT/bin/build-fts.sh}"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-fts-busy.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
selected="$SCRATCH/selected"; moc="$SCRATCH/brain/moc"; shim="$SCRATCH/shim"
mkdir -p "$selected" "$moc" "$shim"
busy="$selected/busy.md"; calm="$selected/calm.md"
printf '%s\n' "$selected" > "$SCRATCH/roots.txt"
printf '# canonical_path\ttitle\tthemes\tkeywords\n%s\tBusy\t-\tbusy\n%s\tCalm\t-\tcalm\n' "$busy" "$calm" > "$moc/index.tsv"
# The shim stands in for cat: while the busy file is being copied it appends a line (size, mtime and ctime change), as many times as MODE allows.
cat > "$shim/cat" <<'SH'
#!/bin/bash
set -eu
if [ "${1:-}" = /dev/fd/9 ] && [ "$(/usr/bin/stat -f %i /dev/fd/9)" = "$(/usr/bin/stat -f %i "$BUSY_FILE")" ]; then
  count="$(/bin/cat "$BUSY_COUNT")"
  if [ "$count" -lt "$BUSY_TIMES" ]; then
    echo $((count + 1)) > "$BUSY_COUNT"
    printf 'busyword changed-%s\n' "$count" >> "$BUSY_FILE"
  fi
fi
exec /bin/cat "$@"
SH
chmod +x "$shim/cat"
run_build() { # $1 = how many times the busy file changes during reads
  echo 0 > "$SCRATCH/count"
  PATH="$shim:/usr/bin:/bin:/usr/sbin:/sbin" NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" \
    BUSY_COUNT="$SCRATCH/count" BUSY_TIMES="$1" BUSY_FILE="$busy" bash "$BUILD" > "$SCRATCH/out.log" 2>&1
}
hits() { sqlite3 "$moc/fts.db" "SELECT count(*) FROM notes WHERE notes MATCH '$1';"; }

# S1: changes once
printf 'busyword first\n' > "$busy"; printf 'calmword stays\n' > "$calm"; rm -f "$moc/fts.db"
run_build 1 || { cat "$SCRATCH/out.log" >&2; echo 'FAIL S1: a file that changed once during its read failed the whole build' >&2; exit 1; }
[ "$(cat "$SCRATCH/count")" = 1 ] || { echo 'FAIL S1: the change was not injected' >&2; exit 1; }
[ "$(hits 'changed')" = 1 ] || { echo 'FAIL S1: the re-read did not bring in the new text' >&2; exit 1; }
! grep -q 'left out' "$SCRATCH/out.log" || { cat "$SCRATCH/out.log" >&2; echo 'FAIL S1: a file that settled on the second try was reported as left out' >&2; exit 1; }

# S2: changes at every read
printf 'busyword first\n' > "$busy"; rm -f "$moc/fts.db"
run_build 99 || { cat "$SCRATCH/out.log" >&2; echo 'FAIL S2: one file that kept changing failed the whole build' >&2; exit 1; }
[ "$(cat "$SCRATCH/count")" -ge 3 ] || { echo "FAIL S2: fewer than 3 tries ($(cat "$SCRATCH/count"))" >&2; exit 1; }
[ "$(hits 'calmword')" = 1 ] || { echo 'FAIL S2: the other file is missing from the build' >&2; exit 1; }
[ "$(hits 'busyword')" = 0 ] || { echo 'FAIL S2: the file that kept changing was indexed anyway' >&2; exit 1; }
grep -q "left out of this build.*busy.md" "$SCRATCH/out.log" || { cat "$SCRATCH/out.log" >&2; echo 'FAIL S2: the skipped file is not logged by name' >&2; exit 1; }
grep -q 'fts skipped: 1 file' "$SCRATCH/out.log" || { echo 'FAIL S2: the skipped count is not reported' >&2; exit 1; }
run_build 0 || { cat "$SCRATCH/out.log" >&2; echo 'FAIL S2: the next build failed' >&2; exit 1; }
[ "$(hits 'busyword')" = 1 ] || { echo 'FAIL S2: the next build did not pick the left-out file up' >&2; exit 1; }
echo 'PASS: a file that changes once is read again (new text indexed); one that changes at every read is left out after 3 tries, logged by name, the build succeeds, and the next build picks it up.'
