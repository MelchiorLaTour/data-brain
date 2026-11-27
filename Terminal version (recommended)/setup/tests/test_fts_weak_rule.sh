#!/usr/bin/env bash
# The "WEAK MATCH" reading hint needs BOTH signals (0.1.31): the top hit matches just ONE of the query's words (and at most half of them), AND it stands less than 8% above the
# next result of the WHOLE ranking. Checked here:
#   a  few words matched but the top hit clearly leads        -> no label (coverage alone would have flagged it)
#   b  few words matched and a twin note ties it              -> label, with both facts
#   c  every word matched, a twin ties it                     -> no label (a tie among real answers is not "not found")
#   d  the same query on a later page (NB_FTS_OFFSET)          -> same decision as page 1 (judged on the whole ranking, not the page)
#   e  one-word queries are never labelled; nothing found prints "no matches"
#   f  a tie whose top hit matches TWO of five words                -> no label (only a top hit resting on a single query word is labelled)
# Invented notes only.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-weak.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
src="$SCRATCH/src"; moc="$SCRATCH/brain/moc"; mkdir -p "$src" "$moc"
printf '%s\n' "$src" > "$SCRATCH/roots.txt"
export NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt"
printf '# path\ttitle\tthemes\tkeywords\n' > "$moc/index.tsv"
note() { printf '%s\n' "$3" > "$src/$1.md"; printf '%s\t%s\t-\t-\n' "$src/$1.md" "$2" >> "$moc/index.tsv"; }
long="$(printf 'plain filler sentence about nothing in particular. %.0s' $(seq 1 40))"
note lead  "Zebrafish tank" "zebrafish zebrafish zebrafish zebrafish zebrafish tank notes"
note faint "Volcano visit" "$long volcano $long"
note twin1 "Walrus a" "walrus tusk colony counted twice this spring on the northern ice"
note twin2 "Walrus b" "walrus tusk colony counted twice this spring on the northern ice"
note both1 "Kestrel nest a" "kestrel nest cliff observation made at dawn from the hide"
note both2 "Kestrel nest b" "kestrel nest cliff observation made at dawn from the hide"
for i in $(seq 1 12); do note "pad$i" "Pad $i" "$long pad note number $i"; done
/bin/bash "$PROJECT_ROOT/bin/build-fts.sh" > "$SCRATCH/build.log" 2>&1 || { cat "$SCRATCH/build.log" >&2; fail "build failed"; }
run() { bash "$PROJECT_ROOT/bin/fts.sh" "$@" 2>/dev/null; }
label() { run "$@" | grep -c 'WEAK MATCH' || true; }

# a: 1 of 4 words matched by the top hit ("zebrafish"), a second note matches another word far less well
out="$(run 'zebrafish volcano pumpkin giraffe')"
printf '%s\n' "$out" | grep -qE 'lead\.md' || fail "a: the lead note is found; got: $out"
[ "$(label 'zebrafish volcano pumpkin giraffe')" = 0 ] || fail "a: a top hit that clearly leads is not labelled weak; got: $out"
# b: the twin notes tie, and the top hit matches 1 of 4 words
out="$(run 'walrus pumpkin giraffe dragon')"
printf '%s\n' "$out" | grep -q 'WEAK MATCH: top hit matches only 1/4 query words and stands only 0.0% above the next result' || fail "b: a tie with few words matched is labelled, with both facts; got: $out"
# c: every word matched, still a tie
[ "$(label 'kestrel nest')" = 0 ] || fail "c: a tie among notes that match every word is not labelled; got: $(run 'kestrel nest')"
# d: later pages decide on the whole ranking
p1="$(label 'walrus pumpkin giraffe dragon')"
p2="$(NB_FTS_OFFSET=1 bash "$PROJECT_ROOT/bin/fts.sh" 'walrus pumpkin giraffe dragon' 1 2>/dev/null | grep -c 'WEAK MATCH' || true)"
[ "$p1" = 1 ] && [ "$p2" = 1 ] || fail "d: page 1 and a later page give the same label decision for a tied query (page 1: $p1, later: $p2)"
p3="$(NB_FTS_OFFSET=1 bash "$PROJECT_ROOT/bin/fts.sh" 'zebrafish volcano pumpkin giraffe' 1 2>/dev/null | grep -c 'WEAK MATCH' || true)"
[ "$p3" = 0 ] || fail "d: a later page of a query whose top hit leads is not labelled just because ranks 2 and 3 are close (got $p3)"
# f: 2 of 5 words matched by the top hit and a twin ties it: the old "at most half the words" test labelled this; the single-word test does not
[ "$(label 'walrus tusk pumpkin giraffe dragon')" = 0 ] || fail "f: a top hit that matches 2 of 5 words is not labelled weak even when a twin ties it; got: $(run 'walrus tusk pumpkin giraffe dragon')"
# e
[ "$(label 'walrus')" = 0 ] || fail "e: a one-word query is never labelled"
run 'zzzznomatch qqqqnomatch' | grep -q '^no matches' || fail "e: nothing found prints 'no matches'"
echo "PASS: the weak label needs both a top hit resting on one query word and a margin under 8% on the whole ranking; a lead, a tie among full matches, later pages and one-word queries are all handled."
