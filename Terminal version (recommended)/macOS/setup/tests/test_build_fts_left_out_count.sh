#!/usr/bin/env bash
# Part 44: Mel's install audit (2026-11-27) said "index lists 6,143 entries while ranked search lists 6,142 source files" and could not say which.
# Cause: a text note that build-fts could not read (3 tries) was dropped from the search index entirely while index.tsv kept its row, and no
# signature was recorded, so every build dropped it again. On Mel's brain that note is the one locally-present note in a folder of online-only ones.
#   G1: one note whose every read fails -> the search index still has one entry per index row (that note by its labels only, no text), the
#       build succeeds and logs it by name.
#   G2: the next build, with the note readable again, reads it: its text becomes searchable.
# Invented notes in a scratch folder. BUILD_FTS can point at a changed copy of build-fts.sh to prove the test fails on it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BUILD="${BUILD_FTS:-$ROOT/bin/build-fts.sh}"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-fts-leftout.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
selected="$SCRATCH/selected"; moc="$SCRATCH/brain/moc"; shim="$SCRATCH/shim"
mkdir -p "$selected" "$moc" "$shim"
blocked="$selected/router.txt"
printf '%s\n' "$selected" > "$SCRATCH/roots.txt"
printf 'p44alpha first note\n' > "$selected/alpha.md"
printf 'p44beta second note\n' > "$selected/beta.md"
printf 'p44blocked third note\n' > "$blocked"
printf '# canonical_path\ttitle\tthemes\tkeywords\n%s\tAlpha\t-\talpha\n%s\tBeta\t-\tbeta\n%s\tRouter\t-\trouter\n' "$selected/alpha.md" "$selected/beta.md" "$blocked" > "$moc/index.tsv"
# The shim stands in for cat: reading the blocked note fails every time (as an open that macOS refuses), the file itself never changes.
cat > "$shim/cat" <<'SH'
#!/bin/bash
if [ "${1:-}" = /dev/fd/9 ] && [ -n "${BLOCKED_FILE:-}" ] && [ "$(/usr/bin/stat -f %i /dev/fd/9)" = "$(/usr/bin/stat -f %i "$BLOCKED_FILE")" ]; then
  echo 'cat: /dev/fd/9: Operation not permitted' >&2; exit 1
fi
exec /bin/cat "$@"
SH
chmod +x "$shim/cat"
run_build() { # $1 = the file whose reads fail, or empty
  PATH="$shim:/usr/bin:/bin:/usr/sbin:/sbin" NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" BLOCKED_FILE="$1" bash "$BUILD" > "$SCRATCH/out.log" 2>&1
}
paths() { sqlite3 "$moc/fts.db" 'SELECT count(DISTINCT path) FROM notes;'; }
hits() { sqlite3 "$moc/fts.db" "SELECT count(*) FROM notes WHERE notes MATCH '$1';"; }
index_rows() { grep -vc '^#' "$moc/index.tsv"; }

# G1
run_build "$blocked" || { cat "$SCRATCH/out.log" >&2; echo 'FAIL G1: one unreadable note failed the whole build' >&2; exit 1; }
[ "$(paths)" = "$(index_rows)" ] || { echo "FAIL G1: search index lists $(paths) source files, index lists $(index_rows) entries" >&2; exit 1; }
[ "$(hits 'p44blocked')" = 0 ] || { echo 'FAIL G1: text that could not be read was indexed' >&2; exit 1; }
[ "$(hits 'p44alpha')" = 1 ] && [ "$(hits 'p44beta')" = 1 ] || { echo 'FAIL G1: the readable notes are missing' >&2; exit 1; }
grep -q 'router.txt' "$SCRATCH/out.log" || { cat "$SCRATCH/out.log" >&2; echo 'FAIL G1: the note that could not be read is not logged by name' >&2; exit 1; }
# G2
run_build '' || { cat "$SCRATCH/out.log" >&2; echo 'FAIL G2: the next build failed' >&2; exit 1; }
[ "$(hits 'p44blocked')" = 1 ] || { echo 'FAIL G2: the next build did not read the note once it was readable' >&2; exit 1; }
[ "$(paths)" = "$(index_rows)" ] || { echo 'FAIL G2: counts differ after the note was read' >&2; exit 1; }
echo 'PASS: a note build-fts cannot read keeps a labels-only search entry (index and search counts stay equal), is logged by name, and is read by the next build once readable.'
