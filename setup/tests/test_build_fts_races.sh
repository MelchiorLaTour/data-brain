#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-fts-race.XXXXXX")" && pwd -P)"
cleanup() {
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

selected="$SCRATCH/selected"
outside="$SCRATCH/outside"
moc="$SCRATCH/brain/moc"
shim="$SCRATCH/shim"
mkdir -p "$selected" "$outside" "$moc" "$shim"
target="$selected/source.md"
held="$SCRATCH/source.held"
sentinel="$outside/source.md"
marker="$SCRATCH/swapped"
printf 'approved source words only\n' > "$target"
printf 'OUTSIDE_SECRET_SENTINEL must never enter FTS\n' > "$sentinel"
printf '%s\n' "$selected" > "$SCRATCH/roots.txt"
printf '# canonical_path\ttitle\tthemes\tkeywords\n%s\tSource\t-\tapproved\n' "$target" > "$moc/index.tsv"
sqlite3 "$moc/fts.db" <<'SQL'
CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, title, themes, keywords, body);
INSERT INTO notes VALUES ('old.md', 'Old', '-', 'preserve', 'PREVIOUS_INDEX_SENTINEL');
SQL
before="$(shasum -a 256 "$moc/fts.db")"
cat > "$shim/cat" <<'SH'
#!/bin/bash
set -eu
if [ "${1:-}" = /dev/fd/9 ] && [ ! -e "$RACE_MARKER" ]; then
  : > "$RACE_MARKER"
  mv "$RACE_TARGET" "$RACE_HELD"
  ln -s "$RACE_OUTSIDE" "$RACE_TARGET"
fi
exec /bin/cat "$@"
SH
chmod +x "$shim/cat"

status=0
PATH="$shim:/usr/bin:/bin:/usr/sbin:/sbin" \
  NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" \
  RACE_TARGET="$target" RACE_HELD="$held" RACE_OUTSIDE="$sentinel" RACE_MARKER="$marker" \
  bash "$ROOT/bin/build-fts.sh" > "$SCRATCH/output.log" 2>&1 || status=$?
[ "$status" -ne 0 ] || { cat "$SCRATCH/output.log" >&2; echo 'FAIL: FTS rebuild accepted a source changed during descriptor copy' >&2; exit 1; }
[ -e "$marker" ] || { cat "$SCRATCH/output.log" >&2; echo 'FAIL: FTS source-swap race was not injected' >&2; exit 1; }
[ "$(shasum -a 256 "$moc/fts.db")" = "$before" ] || { echo 'FAIL: failed FTS rebuild replaced the last usable database' >&2; exit 1; }
! rg -l 'OUTSIDE_SECRET_SENTINEL' "$moc" >/dev/null || { echo 'FAIL: outside bytes entered generated DataBrain state' >&2; exit 1; }
sqlite3 "$moc/fts.db" "SELECT body FROM notes WHERE path='old.md';" | rg -q '^PREVIOUS_INDEX_SENTINEL$' || {
  echo 'FAIL: the prior searchable row was not preserved' >&2
  exit 1
}
echo 'PASS: FTS rebuild rejects a source swapped during descriptor copy, preserves the previous database, and excludes outside bytes.'
