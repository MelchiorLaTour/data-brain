#!/usr/bin/env bash
# Long texts (0.1.30). Until then one cap (800,000 characters) decided two things: a larger text got NO extract at all (so Claude could not read
# it) and it stayed out of the ranked search. Now:
#   - a text up to the read ceiling is extracted IN FULL (a long PDF or Word file can be read to its end through databrain_read);
#   - a text over 800,000 characters is no longer one search row (a textbook would drown ordinary notes): since 0.1.31 it is indexed in sections of
#     about 20,000 characters (test_fts_sections.sh), still one file, and is found by its title and by words at its end;
#   - only a text over the read ceiling is still title-and-keywords-only (NB_READ_CEILING lowers it here so the test stays small).
# pdftotext is a stub that prints a text of a size chosen by the file name. Fake files only.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-extract-long.XXXXXX")" && pwd -P)"
trap '[ -n "${KEEP:-}" ] || rm -rf "$SCRATCH"' EXIT
root="$SCRATCH/root"; moc="$SCRATCH/brain/moc"; bin="$SCRATCH/bin"
mkdir -p "$root" "$moc/extracted" "$bin"; root="$(cd "$root" && pwd -P)"
printf '%s\n' "$root" > "$SCRATCH/roots.txt"
cat > "$bin/pdftotext" <<'SH'
#!/bin/bash
# $2 is the staged copy of the source: its first line names the size to print (many different words, so the end marker is not a derived keyword)
case "$(head -c 8 "$2")" in
  BIGTEXT*) awk 'BEGIN{for(i=0;i<200000;i++) printf "w%d ", i%500; print "bigendmarker"}' ;;      # about 1,000,000 characters
  HUGETEXT) awk 'BEGIN{for(i=0;i<300000;i++) printf "w%d ", i%500; print "hugeendmarker"}' ;;     # about 1,500,000 characters
  *) echo "smallword smallendmarker" ;;
esac
SH
chmod +x "$bin/pdftotext"
printf 'BIGTEXT\n' > "$root/alpha-treatise.pdf"; printf 'SMALLDOC\n' > "$root/small-memo.pdf"; printf 'HUGETEXT\n' > "$root/gamma-atlas.pdf"
{ printf '%s\tAlpha Treatise\t-\t-\n' "$root/alpha-treatise.pdf"; printf '%s\tSmall Memo\t-\t-\n' "$root/small-memo.pdf"; printf '%s\tGamma Atlas\t-\t-\n' "$root/gamma-atlas.pdf"; } > "$moc/index.tsv"
env_run() { env PATH="$bin:/usr/bin:/bin:/opt/homebrew/bin" NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" "$@"; }
env_run NB_READ_CEILING=1200000 bash "$PROJECT_ROOT/bin/extract.sh" > "$SCRATCH/extract.log" 2>&1 || { cat "$SCRATCH/extract.log" >&2; exit 1; }
side() { echo "$moc/extracted/$(printf '%s' "$1" | shasum | cut -c1-16).txt"; }
fail() { echo "FAIL: $*" >&2; cat "$SCRATCH/extract.log" >&2; exit 1; }

big="$(side "$root/alpha-treatise.pdf")"
[ -s "$big" ] || fail "a 1,000,000-character text must be extracted (it is under the read ceiling)"
grep -q 'bigendmarker' "$big" || fail "the extract must hold the text to its END, not a cut"
[ "$(wc -c < "$big")" -gt 900000 ] || fail "the extract is shorter than the text (about 980,000 characters)"
[ -s "$(side "$root/small-memo.pdf")" ] || fail "the small file is extracted as before"
[ -e "$(side "$root/gamma-atlas.pdf")" ] && fail "a text over the read ceiling must not be extracted"
grep -Fq "$root/gamma-atlas.pdf"$'\ttitle_and_keywords_only' "$moc/extract-report.tsv" || fail "the over-ceiling file is reported as title_and_keywords_only"
grep -Fq "$root/alpha-treatise.pdf"$'\textracted' "$moc/extract-report.tsv" || fail "the long file is reported as extracted"

env_run bash "$PROJECT_ROOT/bin/build-fts.sh" > "$SCRATCH/fts.log" 2>&1 || { cat "$SCRATCH/fts.log" >&2; exit 1; }
hits() { /usr/bin/sqlite3 -readonly "$moc/fts.db" "SELECT count(*) FROM notes WHERE notes MATCH '$1';"; }
[ "$(hits smallendmarker)" = 1 ] || fail "a small file's text is searched"
[ "$(hits bigendmarker)" -ge 1 ] || fail "a text over 800,000 characters is searched in sections: its last words are found"
[ "$(/usr/bin/sqlite3 -readonly "$moc/fts.db" "SELECT max(length(body)) FROM notes;")" -lt 100000 ] || fail "and no single search row carries the whole long text (it would drown ordinary notes)"
[ "$(hits 'title:alpha')" = 1 ] || fail "the long file is still found by its title"
echo "PASS: a long text is extracted in full and stays readable, is indexed in sections above 800,000 characters (found by title and by its last words), and only a text over the read ceiling is title-and-keywords-only."
