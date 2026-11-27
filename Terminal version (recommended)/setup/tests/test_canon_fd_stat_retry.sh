#!/usr/bin/env bash
# macOS answers "Bad file descriptor" for `stat /dev/fd/9` now and then under load (4 in 12,000 with 8 parallel loops, 2026-10-12). The read guard
# took the empty answer for a changed file and failed a whole refresh ("approved source changed during read", 23 of 23 traced cases).
# Here a fake stat fails that call a chosen number of times; the guard must ask again (3 tries) and still stop after 3 empty answers.
# CANON_SH can point at an older canon.sh to prove the test fails on it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-fdstat.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/root"
printf '%s\n' "$SCRATCH/root" > "$SCRATCH/roots.txt"
printf 'some approved words\n' > "$SCRATCH/root/note.md"
export NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt"
# shellcheck disable=SC1090
source "${CANON_SH:-$ROOT/bin/canon.sh}"
BUDGET="$SCRATCH/budget"
# The counter lives in a file because stat runs inside $(...) sub-shells.
stat() {
  if [ "${*: -1}" = /dev/fd/9 ] && [ -f "$BUDGET" ] && [ "$(cat "$BUDGET")" -gt 0 ]; then
    echo $(( $(cat "$BUDGET") - 1 )) > "$BUDGET"
    echo 'stat: /dev/fd/9: stat: Bad file descriptor' >&2
    return 1
  fi
  command stat "$@"
}
try() { echo "$1" > "$BUDGET"; rm -f "$SCRATCH/out"; copy_approved_source "$SCRATCH/root/note.md" "$SCRATCH/out" 2>/dev/null; }

try 0 || { echo 'FAIL: the plain copy failed with a working stat' >&2; exit 1; }
cmp -s "$SCRATCH/out" "$SCRATCH/root/note.md" || { echo 'FAIL: the plain copy is not the file' >&2; exit 1; }
try 1 || { echo 'FAIL: one empty answer from stat /dev/fd/9 failed the copy (it must ask again)' >&2; exit 1; }
cmp -s "$SCRATCH/out" "$SCRATCH/root/note.md" || { echo 'FAIL: the copy after one empty answer is not the file' >&2; exit 1; }
try 2 || { echo 'FAIL: two empty answers in a row failed the copy (3 tries are allowed)' >&2; exit 1; }
if try 3; then echo 'FAIL: three empty answers in a row were accepted (the guard must still stop)' >&2; exit 1; fi
[ ! -e "$SCRATCH/out" ] || { echo 'FAIL: bytes were published after the guard stopped' >&2; exit 1; }
echo 'PASS: an empty stat of /dev/fd/9 is asked again up to 3 times (1 and 2 empty answers copy the file); 3 in a row still stop the copy and publish nothing.'
