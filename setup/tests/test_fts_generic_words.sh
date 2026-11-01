#!/usr/bin/env bash
# Generic words in a query (notes, note, files, file, documents, document, docs; FR: notes, fichiers, documents) are dropped from the search
# ONLY when the query has at least one other real word. "beekeeping notes" must count the bee notes only, not every note that says "notes".
# A query made only of generic words still searches them. Invented notes only.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-generic.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
src="$SCRATCH/src"; moc="$SCRATCH/brain/moc"; mkdir -p "$src" "$moc"
printf '%s\n' "$src" > "$SCRATCH/roots.txt"
export NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt"
printf '# path\ttitle\tthemes\tkeywords\n' > "$moc/index.tsv"
note() { printf '%s\n' "$3" > "$src/$1.md"; printf '%s\t%s\t-\t-\n' "$src/$1.md" "$2" >> "$moc/index.tsv"; }
for i in 1 2 3; do note "bee$i" "Hive visit $i" "Beekeeping log $i: the hive was calm and the queen was laying well."; done
for i in 1 2 3 4 5 6; do note "other$i" "Misc $i" "These notes cover item $i. Keep the files and documents together with the notes."; done
note ruche "Ruche" "Notes d'apiculture : la ruche est calme."
note fich "Fichiers divers" "Rangez les fichiers et les documents."
/bin/bash "$PROJECT_ROOT/bin/build-fts.sh" > "$SCRATCH/build.log" 2>&1 || { cat "$SCRATCH/build.log" >&2; fail "build failed"; }
total() { NB_FTS_COUNT=1 bash "$PROJECT_ROOT/bin/fts.sh" "$@" 2>/dev/null | sed -n 's/^matches: //p'; }
t="$(total 'beekeeping notes' || true)"; [ "$t" = 3 ] || fail "'beekeeping notes' must match the 3 bee notes only; got '$t'"
t="$(total 'beekeeping files and documents' || true)"; [ "$t" = 3 ] || fail "'beekeeping files and documents' must match 3; got '$t'"
t="$(total 'apiculture notes fichiers' || true)"; [ "$t" = 1 ] || fail "French: 'apiculture notes fichiers' must match 1; got '$t'"
t="$(total 'notes' || true)"; [ "$t" -ge 7 ] || fail "'notes' alone must still search 'notes' (at least 7 matches); got '$t'"
t="$(total 'documents files' || true)"; [ "$t" -ge 7 ] || fail "a query of only generic words must still search them; got '$t'"
# a word that only contains a generic word is a real word
note notebook "Notebook" "The notebook sits on the desk."
/bin/bash "$PROJECT_ROOT/bin/build-fts.sh" > "$SCRATCH/build.log" 2>&1
t="$(total 'notebook notes' || true)"; [ "$t" = 1 ] || fail "'notebook notes' must match only the notebook note; got '$t'"
echo "PASS: generic words are dropped only when another real word is present."
