#!/usr/bin/env bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
TMP="$(cd -P "$TMP" && pwd -P)"
trap 'rm -rf "$TMP"' EXIT
HOME="$TMP/home"
ROOT="$HOME/approved"
OUTSIDE="$HOME/outside"
MOC="$TMP/moc"
mkdir -p "$ROOT" "$OUTSIDE" "$MOC"
printf '%s\n' "$ROOT" > "$TMP/roots"
printf '# canonical_path\ttitle\tthemes\tkeywords\n' > "$MOC/index.tsv"

export HOME NB_CANON_ROOTS_FILE="$TMP/roots" NB_MOC_DIR="$MOC"

# A pre-existing filename must remain intact; capture creates the next free name.
DATE="$(date '+%Y-%m-%d')"
printf 'DO NOT REPLACE\n' > "$ROOT/$DATE Capture safety fixture.md"
printf '%s\n' 'Rare indigo kestrel signal recorded for retrieval.' |
  bash "$PROJECT_ROOT/bin/capture.sh" 'Capture safety fixture' 'indigo,kestrel' "$ROOT" > "$TMP/capture.log"
NEW="$ROOT/$DATE Capture safety fixture (1).md"
[ -f "$NEW" ] || { cat "$TMP/capture.log" >&2; echo 'capture did not create the collision-safe note' >&2; exit 1; }
grep -Fq 'indigo,kestrel' "$MOC/index.tsv"
grep -Fq "${NEW/#$HOME/~}" "$MOC/inventory.tsv"
grep -Fq "${NEW/#$HOME/~}" <(bash "$PROJECT_ROOT/bin/fts.sh" 'indigo kestrel')
[ "$(cat "$ROOT/$DATE Capture safety fixture.md")" = 'DO NOT REPLACE' ]

# A destination outside the approved root must fail without creating a note.
if printf '%s\n' 'OUTSIDE_SENTINEL' | bash "$PROJECT_ROOT/bin/capture.sh" 'Outside fixture' 'outside,denied' "$OUTSIDE" >"$TMP/denied.out" 2>"$TMP/denied.err"; then
  echo 'capture unexpectedly accepted an outside destination' >&2; exit 1
fi
grep -Fq 'inside an already approved source folder' "$TMP/denied.err"
[ -z "$(find "$OUTSIDE" -type f -print -quit)" ]

# Missing keywords fail clearly when there is no interactive terminal.
if printf '%s\n' 'NONINTERACTIVE_SENTINEL' |
  bash "$PROJECT_ROOT/bin/capture.sh" 'Missing keywords' '-' "$ROOT" >"$TMP/prompt.out" 2>"$TMP/prompt.err"; then
  echo 'capture unexpectedly accepted unprompted missing keywords' >&2; exit 1
fi
grep -Fq 'provide 2–12 keywords, or run interactively' "$TMP/prompt.err"
[ ! -e "$ROOT/$DATE Missing keywords.md" ]

# Repeated terms do not count as two distinct search keywords.
if printf '%s\n' 'DUPLICATE_KEYWORD_SENTINEL' |
  bash "$PROJECT_ROOT/bin/capture.sh" 'Duplicate keywords' 'indigo,indigo' "$ROOT" >"$TMP/duplicate.out" 2>"$TMP/duplicate.err"; then
  echo 'capture unexpectedly accepted duplicate-only keywords' >&2; exit 1
fi
grep -Fq '2–12 distinct search keywords' "$TMP/duplicate.err"
[ ! -e "$ROOT/$DATE Duplicate keywords.md" ]

# Private capture text must never be appended into the product checkout.
if rg -l -F 'Rare indigo kestrel signal recorded for retrieval.' "$PROJECT_ROOT" --glob '!**/.git/**' --glob '!setup/tests/test_terminal_capture.sh' >/dev/null; then
  echo 'capture content leaked into the product checkout' >&2; exit 1
fi
[ ! -e "$PROJECT_ROOT/INBOX.md" ] || ! rg -q -F 'Rare indigo kestrel signal recorded for retrieval.' "$PROJECT_ROOT/INBOX.md"
echo 'PASS: terminal capture is root-confined, collision-safe, keyword-indexed, searchable, inventoried, and checkout-clean'
