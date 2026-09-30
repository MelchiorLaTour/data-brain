#!/usr/bin/env bash
# Incremental search index (plan 11): only changed/added/deleted rows are re-read, the result equals a
# from-scratch build, an old-schema or corrupt DB falls back to a full build, and prune-missing drops
# only rows whose file is really gone.
set -euo pipefail

ENGINE="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-fts-incr.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
src="$SCRATCH/src"; moc="$SCRATCH/brain/moc"
mkdir -p "$src/a" "$src/b" "$moc"
printf '%s\n' "$src" > "$SCRATCH/roots.txt"
export NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt"

i=0
: > "$moc/index.tsv"; printf '# path\ttitle\tthemes\tkeywords\n' >> "$moc/index.tsv"
for dir in a b; do
  for n in 1 2 3; do
    i=$((i + 1))
    printf 'body number %s marker%s common\n' "$i" "$i" > "$src/$dir/n$i.md"
    printf '%s\tNote %s\tgroup%s\tkw%s\n' "$src/$dir/n$i.md" "$i" "$dir" "$i" >> "$moc/index.tsv"
  done
done

build() { bash "$ENGINE/bin/build-fts.sh" 2>&1; }
count() { sqlite3 -readonly "$moc/fts.db" "SELECT count(*) FROM $1;"; }
hits() { sqlite3 -readonly "$moc/fts.db" "SELECT count(*) FROM notes WHERE notes MATCH '$1';"; }
dump() { sqlite3 -readonly "$1" "SELECT path||char(31)||title||char(31)||themes||char(31)||keywords||char(31)||body FROM notes ORDER BY path" | shasum -a 256; }
fail() { echo "FAIL: $*" >&2; exit 1; }

out="$(build)"; echo "$out" | grep -q 'fts mode: full' || fail "first build must be full: $out"
[ "$(count notes)" = 6 ] && [ "$(count sig)" = 6 ] || fail "first build row counts"

out="$(build)"; echo "$out" | grep -q '0 row(s) re-read, 0 path(s) removed, 6 unchanged' || fail "unchanged rerun must open nothing: $out"

# add
printf 'freshly added quillfern body\n' > "$src/a/added.md"
printf '%s\tAdded\tgroupa\tkwadd\n' "$src/a/added.md" >> "$moc/index.tsv"
out="$(build)"; echo "$out" | grep -q '1 row(s) re-read, 0 path(s) removed, 6 unchanged' || fail "add must re-read exactly one row: $out"
[ "$(hits quillfern)" = 1 ] && [ "$(count notes)" = 7 ] || fail "added file not searchable"

# change (content and mtime differ)
sleep 1; printf 'rewritten marigold body\n' > "$src/b/n4.md"
out="$(build)"; echo "$out" | grep -q '1 row(s) re-read' || fail "change must re-read exactly one row: $out"
[ "$(hits marigold)" = 1 ] && [ "$(hits marker4)" = 0 ] || fail "changed content not replaced"

# label-only change (index row edited, file untouched)
awk -F'\t' 'BEGIN{OFS="\t"} $2=="Note 2"{$3="relabelled"} {print}' "$moc/index.tsv" > "$moc/index.new" && mv "$moc/index.new" "$moc/index.tsv"
out="$(build)"; echo "$out" | grep -q '1 row(s) re-read' || fail "a label change must re-read exactly one row: $out"
[ "$(hits relabelled)" = 1 ] || fail "new label not searchable"

# delete: file and its row are gone
rm "$src/a/n1.md"; grep -v '/a/n1.md' "$moc/index.tsv" > "$moc/index.new" && mv "$moc/index.new" "$moc/index.tsv"
out="$(build)"; echo "$out" | grep -q '0 row(s) re-read, 1 path(s) removed' || fail "delete must remove exactly one path: $out"
[ "$(hits marker1)" = 0 ] && [ "$(count notes)" = 6 ] && [ "$(count sig)" = 6 ] || fail "deleted file still indexed"

# equivalence: the incremental result equals a from-scratch build of the same index
NB_FTS_DB="$SCRATCH/fresh.db" bash "$ENGINE/bin/build-fts.sh" >/dev/null 2>&1
[ "$(dump "$moc/fts.db")" = "$(dump "$SCRATCH/fresh.db")" ] || fail "incremental index differs from a from-scratch build"

# old-schema DB (no sig table) and a corrupt DB both fall back to one full build
sqlite3 "$moc/fts.db" 'DROP TABLE sig;'
out="$(build)"; echo "$out" | grep -q 'fts mode: full' && [ "$(count sig)" = 6 ] || fail "old-schema DB must trigger a full build that creates sig: $out"
printf 'garbage' > "$moc/fts.db"
out="$(build)"; echo "$out" | grep -q 'fts mode: full' && [ "$(count notes)" = 6 ] || fail "corrupt DB must trigger a full build: $out"

# a failed incremental build leaves the previous index untouched
before="$(shasum -a 256 "$moc/fts.db")"
printf 'x\n' > "$src/b/n5.md"; sleep 1; printf 'changed\n' > "$src/b/n5.md"
mkdir -p "$SCRATCH/shim"
printf '#!/bin/sh\nexit 3\n' > "$SCRATCH/shim/sqlite3-fail"; chmod +x "$SCRATCH/shim/sqlite3-fail"
printf '#!/bin/sh\nif [ "$1" != -readonly ]; then exit 3; fi\nexec /usr/bin/sqlite3 "$@"\n' > "$SCRATCH/shim/sqlite3"; chmod +x "$SCRATCH/shim/sqlite3"
if PATH="$SCRATCH/shim:$PATH" bash "$ENGINE/bin/build-fts.sh" >/dev/null 2>&1; then fail "a failing SQLite must fail the build"; fi
[ "$(shasum -a 256 "$moc/fts.db")" = "$before" ] || fail "a failed build must preserve the previous index"

# prune-missing: only rows whose file is gone, under a root that still exists
printf '%s\tOutside\tx\tk\n' "$SCRATCH/notaroot/file.md" >> "$moc/index.tsv"
rm -rf "$src/b"
rows_before="$(grep -vc '^#' "$moc/index.tsv")"
out="$(bash "$ENGINE/bin/prune-missing.sh")"; echo "$out" | grep -q 'row(s) removed' || fail "prune output: $out"
rows_after="$(grep -vc '^#' "$moc/index.tsv")"
[ "$rows_after" = "$((rows_before - 3))" ] || fail "prune must drop the 3 rows of the deleted folder, not $((rows_before - rows_after))"
grep -q notaroot "$moc/index.tsv" || fail "a row outside the selected roots must not be pruned"
grep -q '/a/n2.md' "$moc/index.tsv" || fail "a row whose file still exists must be kept"
if grep -q 'b/n' "$moc/index.tsv"; then fail "rows of the deleted folder remain"; fi
# a selected root that is unavailable (unplugged volume, renamed folder) must cost no rows
mv "$src" "$SCRATCH/src-moved"
rows_kept="$(grep -vc '^#' "$moc/index.tsv")"
bash "$ENGINE/bin/prune-missing.sh" >/dev/null 2>&1 || true
[ "$(grep -vc '^#' "$moc/index.tsv")" = "$rows_kept" ] || fail "an unavailable root must cost no rows"

echo "PASS: incremental search index re-reads only changed rows, equals a full build, falls back safely, keeps the old index on failure; prune-missing drops only gone files."
