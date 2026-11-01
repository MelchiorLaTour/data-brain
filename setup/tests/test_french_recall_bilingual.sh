#!/usr/bin/env bash
# Recall on a synthetic bilingual brain (0.1.30): 200 invented notes (130 English, 70 French) and 30 questions, 15 in each language, plus a second
# brain where French is only 15 of 145 notes (the case the French index is for). All invented (setup/tests/bilingual_bench), never a real brain.
# Measured on 2026-10-14 (rank-1 hits out of 15 French questions): 0.1.29 search 12/15; with accent-aware words and French stopwords 13/15; with the
# French index too 14/15 (and 15/15 on the skewed brain). English stays at 14/15. The terminal engine scores 12/15 on both.
# Asserted: French rank-1 >= 14/15 on both brains, French in the first 5 = 15/15, English unchanged (>= 14/15 at rank 1).
set -euo pipefail
export NB_FR_INDEX=on   # the French merge is off by default since 0.1.31; this test covers the kept code
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
BENCH="$PROJECT_ROOT/setup/tests/bilingual_bench"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-bilingual.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
FTS="${DATABRAIN_FTS_SCRIPT:-$PROJECT_ROOT/bin/fts.sh}"      # a mutant copy of fts.sh can be swapped in here
python3 "$BENCH/gen.py" "$SCRATCH/main" 130 70 7 > /dev/null
python3 "$BENCH/make_skew.py" "$SCRATCH/main" "$SCRATCH/skew" 15 > /dev/null
for case in main skew; do
  C="$SCRATCH/$case"; mkdir -p "$C/brain/moc"; cp "$C/index.tsv" "$C/brain/moc/index.tsv"; printf '%s\n' "$C/src" > "$C/roots.txt"
  NB_MOC_DIR="$C/brain/moc" NB_CANON_ROOTS_FILE="$C/roots.txt" bash "$PROJECT_ROOT/bin/build-fts.sh" > "$C/build.log" 2>&1 || { cat "$C/build.log" >&2; fail "$case: index build failed"; }
  [ -f "$C/brain/moc/fts_fr.db" ] || fail "$case: the build must also make the French index (fts_fr.db)"
  python3 "$BENCH/evalq.py" "$C" env NB_MOC_DIR="$C/brain/moc" bash "$FTS" > "$C/result.txt"
  en1="$(awk '/^en:/{split($3,a,"/"); print a[1]}' "$C/result.txt")"; fr1="$(awk '/^fr:/{split($3,a,"/"); print a[1]}' "$C/result.txt")"
  fr5="$(awk '/^fr:/{split($7,a,"/"); print a[1]}' "$C/result.txt")"
  echo "$case: English rank-1 $en1/15, French rank-1 $fr1/15, French in the first 5: $fr5/15"
  [ "$fr1" -ge 14 ] || { cat "$C/result.txt" >&2; fail "$case: French rank-1 must be at least 14 of 15 (got $fr1)"; }
  [ "$fr5" -ge 15 ] || { cat "$C/result.txt" >&2; fail "$case: every French question must be answered in the first 5 (got $fr5)"; }
  [ "$en1" -ge 14 ] || { cat "$C/result.txt" >&2; fail "$case: English rank-1 must stay at least 14 of 15 (got $en1)"; }
done
echo "PASS: on invented bilingual brains French rank-1 is at least 14/15 and 15/15 in the first 5 (it was 12/15 before 0.1.30), English stays at 14/15."
