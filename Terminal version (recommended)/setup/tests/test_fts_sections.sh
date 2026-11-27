#!/usr/bin/env bash
# A large extracted text (over 800,000 bytes: a manual, a textbook) is searched IN SECTIONS (0.1.31): one index row per section of about 20,000
# characters, all with the file's path, labels on the first. Search folds them into one hit and lists the sections that matched ("sections: N/M:start").
# Also checked: an index built by 0.1.30 (no `sec` column) is rebuilt in full, an incremental run keeps sections, and removing the text drops them.
# Invented text only.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-sections.XXXXXX")" && pwd -P)"
trap "[ -n \"\${KEEP:-}\" ] || rm -rf \"\$SCRATCH\"" EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
src="$SCRATCH/src"; moc="$SCRATCH/brain/moc"; mkdir -p "$src" "$moc/extracted"
printf '%s\n' "$src" > "$SCRATCH/roots.txt"
export NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt"
printf 'pdf placeholder\n' > "$src/big.pdf"; printf 'smallmarker an ordinary note\n' > "$src/small.md"
printf '# path\ttitle\tthemes\tkeywords\n%s\tBigtitleword manual\tmanuals\tbigkw\n%s\tSmall\t-\t-\n' "$src/big.pdf" "$src/small.md" > "$moc/index.tsv"
hash="$(printf '%s' "$src/big.pdf" | shasum | cut -c1-16)"
fp="$(stat -f '%i:%z:%m:%c' "$src/big.pdf")"
body="$SCRATCH/body.txt"
/usr/bin/perl -e 'for my $i (1..4200) { my $l = "line $i of the manual: " . join(" ", map { "w" . (($i * 7 + $_) % 997) } 1..38); $l .= " alphasecword bothword" if $i == 100; $l .= " omegasecword bothword" if $i == 3900; print "$l\n"; }' > "$body"
[ "$(wc -c < "$body")" -gt 800000 ] || fail "the invented text must be over 800,000 bytes ($(wc -c < "$body"))"
{ printf '<!-- newbrain-extract source: %s -->\n<!-- newbrain-extract fingerprint: %s -->\n' "$src/big.pdf" "$fp"; cat "$body"; } > "$moc/extracted/$hash.txt"
build() { bash "$PROJECT_ROOT/bin/build-fts.sh" 2>&1; }
db() { sqlite3 -readonly "$moc/fts.db" "$@"; }
fts() { bash "$PROJECT_ROOT/bin/fts.sh" "$@" 2>/dev/null; }

out="$(build)" || fail "build: $out"
printf '%s' "$out" | grep -q 'built: 2 rows indexed' || fail "two files, so two rows counted by file: $out"
M="$(db "SELECT count(*) FROM notes WHERE path LIKE '%big.pdf';")"
[ "$M" -ge 30 ] && [ "$M" -le 60 ] || fail "the large text is split into about 20,000-character sections (got $M rows)"
[ "$(db 'SELECT sections FROM meta;')" = "$M" ] || fail "meta.sections counts the section rows"
[ "$(db "SELECT count(*) FROM notes WHERE path LIKE '%big.pdf' AND title != '';")" = 1 ] || fail "only the first section carries the labels"
# a word deep in the text is found, as ONE hit, with the section it is in
res="$(NB_FTS_COUNT=1 fts omegasecword)"
printf '%s\n' "$res" | grep -q '^matches: 1$' || fail "one file matches (count by file): $res"
[ "$(printf '%s\n' "$res" | grep -c 'big.pdf')" = 1 ] || fail "one hit line for the file: $res"
sec="$(printf '%s\n' "$res" | sed -n 's/^ *sections: //p')"
printf '%s' "$sec" | grep -Eq "^([2-9]|[1-9][0-9])/$M:[0-9]+$" || fail "the hit names its section as N/M:start with N above 1 (got '$sec')"
start="${sec##*:}"
pos="$(/usr/bin/perl -e 'local $/; open(F,"<",$ARGV[0]); my $t=<F>; print index($t,"omegasecword")' "$body")"
[ "$pos" -ge "$start" ] && [ "$pos" -lt $((start + 25000)) ] || fail "the section starts ($start) just before the word ($pos)"
# a word in two sections: one hit, both sections listed, best first
res="$(fts bothword)"
[ "$(printf '%s\n' "$res" | grep -c 'big.pdf')" = 1 ] || fail "two matching sections still make one hit: $res"
[ "$(printf '%s\n' "$res" | sed -n 's/^ *sections: //p' | wc -w | tr -d ' ')" = 2 ] || fail "both sections are listed: $res"
# the title still finds it, and an ordinary note is unchanged
fts bigtitleword | grep -q 'big.pdf' || fail "the title finds the file"
fts smallmarker | grep -q 'small.md' && [ -z "$(fts smallmarker | grep "^ *sections:" || true)" ] || fail "an ordinary note has no sections line: $(fts smallmarker | cat -v)"
# an index from 0.1.30 (no sec column, no meta) is rebuilt in full
rm -f "$moc/fts.db"
sqlite3 "$moc/fts.db" "CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, title, themes, keywords, body, tokenize='porter unicode61 remove_diacritics 2'); CREATE TABLE sig(path TEXT, sig TEXT); INSERT INTO notes VALUES('$src/small.md','Small','-','-','smallmarker old'); INSERT INTO sig VALUES('$src/small.md','x');"
out="$(build)" || fail "rebuild of an old index: $out"
printf '%s' "$out" | grep -q 'fts mode: full' || fail "an index without the sec column is rebuilt in full: $out"
[ "$(db "SELECT count(*) FROM notes WHERE path LIKE '%big.pdf';")" = "$M" ] || fail "the rebuilt index has the sections"
# incremental: an edit elsewhere keeps the sections; removing the text drops them
printf 'smallmarker edited\n' > "$src/small.md"; sleep 1
out="$(build)" || fail "incremental build: $out"
printf '%s' "$out" | grep -q 'fts mode: incremental' || fail "second build is incremental: $out"
[ "$(db "SELECT count(*) FROM notes WHERE path LIKE '%big.pdf';")" = "$M" ] || fail "an incremental run keeps the sections"
rm -f "$moc/extracted/$hash.txt"
out="$(build)" || fail "build after removing the text: $out"
[ "$(db "SELECT count(*) FROM notes WHERE path LIKE '%big.pdf';")" = 1 ] || fail "with the text gone only the labels row is left"
[ "$(db 'SELECT sections FROM meta;')" = 0 ] || fail "meta.sections is 0 again"
echo "PASS: a large text is indexed in sections and found as one hit that names its sections; an old index is rebuilt; incremental runs keep or drop the sections correctly."
