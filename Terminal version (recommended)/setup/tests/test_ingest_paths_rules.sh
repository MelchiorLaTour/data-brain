#!/usr/bin/env bash
# ingest-root.sh --paths FILE adds only the listed files, and every folder and privacy rule of the full walk still holds on each of them:
# a file outside the selected folder, a path that climbs out with .., a symlink, a file inside a symlinked folder, a pruned folder
# (node_modules), a type that is not read, a file the user excluded, a private name and a private text are never given a row, while ordinary
# listed files are. For the same set of files the listed mode and the full walk produce the same rows.
set -euo pipefail

ENGINE="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-ingest-paths.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
src="$SCRATCH/src"; outside="$SCRATCH/outside"
mkdir -p "$src/a" "$src/node_modules/pkg" "$src/Resources/Sensitive" "$src/payslips" "$outside/dir"
printf '%s\n' "$src" > "$SCRATCH/roots.txt"
export NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" NB_PRIVACY_FILE="$SCRATCH/privacy.tsv"

printf 'ordinary note\n' > "$src/a/ok.md"
printf 'second ordinary note\n' > "$src/a/ok2.txt"
printf -- '---\ntags: [alpha, beta]\n---\nnote with tags\n' > "$src/a/tagged.md"
printf 'excluded by the user\n' > "$src/a/excluded.md"
printf 'cloud only\n' > "$src/a/cloud.md"
printf 'in a pruned folder\n' > "$src/node_modules/pkg/dep.md"
printf 'in the sensitive folder\n' > "$src/Resources/Sensitive/key.md"
printf 'in a private-looking folder\n' > "$src/payslips/march.md"
printf 'private name\n' > "$src/a/payslip-march.md"
printf 'my iban is FR1420041010050500013M02606 keep it\n' > "$src/a/note-with-iban.md"
printf 'not a read type\n' > "$src/a/picture.jpg"
printf 'outside the folder\n' > "$outside/out.md"
printf 'target outside\n' > "$outside/target.md"
printf 'inside a symlinked folder\n' > "$outside/dir/in.md"
ln -s "$outside/target.md" "$src/a/link.md"
ln -s "$outside/dir" "$src/a/linkdir"
printf 'excluded\t%s\tby the user\n' "$src/a/excluded.md" > "$SCRATCH/privacy.tsv"
printf '%s\n' "$src/a/cloud.md" > "$SCRATCH/dataless.txt"

everything=(
  "$src/a/ok.md" "$src/a/ok2.txt" "$src/a/tagged.md" "$src/a/excluded.md" "$src/a/cloud.md" "$src/node_modules/pkg/dep.md"
  "$src/Resources/Sensitive/key.md" "$src/payslips/march.md" "$src/a/payslip-march.md" "$src/a/note-with-iban.md" "$src/a/picture.jpg"
  "$outside/out.md" "$src/a/link.md" "$src/a/linkdir/in.md" "$src/a/../../outside/out.md" "$src/a/does-not-exist.md"
)
printf '%s\n' "${everything[@]}" > "$SCRATCH/list.txt"

fail() { echo "FAIL: $*" >&2; exit 1; }
fresh_moc() { rm -rf "$1"; mkdir -p "$1"; printf '# path\ttitle\tthemes\tkeywords\n%s\tSeed\tgroup\tkw\n' "$src/a/seed.md" > "$1/index.tsv"; printf 'seed\n' > "$src/a/seed.md"; }
run() { NB_MOC_DIR="$1" NB_TEST_DATALESS_LIST="$SCRATCH/dataless.txt" bash "$ENGINE/bin/ingest-root.sh" "$src" "${@:2}" 2>&1; }

# listed mode
fresh_moc "$SCRATCH/moc-listed"
out="$(run "$SCRATCH/moc-listed" --paths "$SCRATCH/list.txt")" || fail "listed ingest: $out"
rows="$(cut -f1 "$SCRATCH/moc-listed/index.tsv" | grep -v '^#' | sort)"
for want in "$src/a/ok.md" "$src/a/ok2.txt" "$src/a/tagged.md" "$src/a/seed.md"; do
  printf '%s\n' "$rows" | grep -qxF "$want" || fail "an ordinary listed file must get a row: $want"
done
for never in excluded.md cloud.md dep.md key.md march.md payslip-march.md note-with-iban.md picture.jpg out.md link.md in.md does-not-exist.md; do
  printf '%s\n' "$rows" | grep -q "/$never\$" && fail "$never must NOT get a row in listed mode"
done
grep -q "tagged.md.*alpha,beta" "$SCRATCH/moc-listed/index.tsv" || fail "the tags of a listed note must still be read into the keywords column"
[ "$(printf '%s\n' "$rows" | wc -l | tr -d ' ')" = 4 ] || fail "exactly the 3 ordinary files plus the seed row, got: $rows"
# the private name and the private text are put on the held list, as the walk does
grep -q "held.*payslip-march.md" "$SCRATCH/privacy.tsv" || fail "the private-looking name must be held for review"
grep -q "held.*note-with-iban.md" "$SCRATCH/privacy.tsv" || fail "the private text must be held for review"

# a list with nothing usable adds nothing and is not an error
fresh_moc "$SCRATCH/moc-empty"
printf '%s\n' "$outside/out.md" "$src/a/link.md" > "$SCRATCH/none.txt"
out="$(run "$SCRATCH/moc-empty" --paths "$SCRATCH/none.txt")" || fail "an unusable list must not fail: $out"
[ "$(grep -vc '^#' "$SCRATCH/moc-empty/index.tsv")" = 1 ] || fail "an unusable list must add no rows"

# the same files through the full walk give the same rows
rm -f "$SCRATCH/privacy.tsv"; printf 'excluded\t%s\tby the user\n' "$src/a/excluded.md" > "$SCRATCH/privacy.tsv"
fresh_moc "$SCRATCH/moc-walk"
out="$(run "$SCRATCH/moc-walk")" || fail "walk ingest: $out"
walk_rows="$(cut -f1 "$SCRATCH/moc-walk/index.tsv" | grep -v '^#' | sort)"
[ "$walk_rows" = "$rows" ] || fail "listed mode and the full walk disagree. walk:
$walk_rows
listed:
$rows"
cmp -s <(sort "$SCRATCH/moc-walk/index.tsv") <(sort "$SCRATCH/moc-listed/index.tsv") || fail "listed mode and the full walk wrote different rows"

echo 'PASS: ingest-root --paths gives rows only to ordinary listed files (outside, .., symlink, symlinked folder, pruned and sensitive folders, other types, excluded, cloud-only, private names and private text never do), reads tags like the walk, and writes the same rows as the full walk'
