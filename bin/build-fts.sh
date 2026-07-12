#!/usr/bin/env bash
# build-fts.sh — build the FTS5 ranked-search index (moc/fts.db). Works with Claude OFF.
# Companion to search.sh: search.sh is the phrase-regex safety net; fts.sh (this DB) is the
# BM25-ranked, OR-by-default, label-aware layer that lets natural-language queries reach a note
# through its title/themes/keywords AND its body — the gap the red-team exam exposed in the
# regex engine (labels were never in the loop).
#
# Corpus = moc/index.tsv rows (the label source of truth). index.tsv already reflects canon.sh's
# prune, so the FTS corpus inherits the same scope — we do NOT re-walk the filesystem. For each row
# we index its labels plus a body:
#   - local text note (.md/.txt/.markdown, present, NOT iCloud-dataless) -> read the file directly
#   - everything else (pdf/docx/doc/pages/rtf, or an offloaded/dataless text note) -> read its
#     moc/extracted/ sidecar (derived plaintext). We NEVER open a dataless original: reading one
#     forces a macOS download and fights extract.sh's re-evict, exactly like search.sh's main pass.
#   - no local text and no sidecar -> labels-only row (e.g. the 9 title-only notes).
# fts.db is a DERIVED artifact under moc/ (regenerable, like extracted/); rerun this to rebuild.
#
# Load path: build a CSV (short label fields escaped in bash; note bodies escaped with `sed`, which
# is C-fast — bash ${//} on the multi-MB extracted sidecars is quadratic and stalls) and feed it to
# sqlite3's CSV importer, which parses quoted fields with embedded newlines in one pass.
set -uo pipefail   # no -e: a data-munging loop; a missing file / empty read is normal, not fatal.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Shared artifact ignore list (M4): canon.sh defines ARTIFACTS + is_artifact(), the ONE exclusion
# mechanism all three consumers honor — no more per-script hardcoded basename lists.
source "$ROOT/bin/canon.sh"
# INDEX/DB default to live; NB_FTS_INDEX / NB_FTS_DB override them for scratch A/B measurement
# (env unset = live behavior — transparent to normal callers).
INDEX="${NB_FTS_INDEX:-$ROOT/moc/index.tsv}"
EXTRACTED="$ROOT/moc/extracted"
DB="${NB_FTS_DB:-$ROOT/moc/fts.db}"
CSV="$(mktemp)"; MAP="$(mktemp)"; trap 'rm -f "$CSV" "$MAP"' EXIT
[ -f "$INDEX" ] || { echo "build-fts: no index.tsv at $INDEX" >&2; exit 1; }

# Reverse map: canonical tilde-path -> sidecar file. Each sidecar's first line is
# `<!-- newbrain-extract source: <~tilde-path> -->`; sources are already in ~ form, matching
# index.tsv col1 exactly, so no path normalization is needed.
if [ -d "$EXTRACTED" ]; then
  for s in "$EXTRACTED"/*.txt; do
    [ -f "$s" ] || continue
    src="$(sed -n '1s/^<!-- newbrain-extract source: //;1s/ -->$//;1p' "$s")"
    [ -n "$src" ] && printf '%s\t%s\n' "$src" "$s" >> "$MAP"
  done
fi

qfield() { local s=$1; printf '"%s"' "${s//\"/\"\"}"; }   # CSV-quote a short field: " -> ""

# Emit CSV rows. Body files are streamed through sed (quotes doubled) between an opening and
# closing quote; sqlite's CSV importer stitches embedded newlines back into one field.
: > "$CSV"
rows=0
while IFS=$'\t' read -r path title themes keywords; do
  [ -z "$path" ] || [ "${path:0:1}" = "#" ] && continue
  is_artifact "$path" && continue
  real="${path/#\~/$HOME}"
  bodyfile=""
  ext="${path##*.}"; ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
  if { [ "$ext" = "md" ] || [ "$ext" = "txt" ] || [ "$ext" = "markdown" ]; } && [ -f "$real" ]; then
    # local text note — but skip if offloaded (dataless): reading it would force a download.
    flags="$(stat -f '%Sf' "$real" 2>/dev/null || true)"
    case "$flags" in *dataless*) : ;; *) bodyfile="$real";; esac
  fi
  if [ -z "$bodyfile" ]; then
    sc="$(grep -m1 -F "$path"$'\t' "$MAP" 2>/dev/null | cut -f2)"
    [ -n "$sc" ] && [ -f "$sc" ] && bodyfile="$sc"
  fi
  printf '%s,%s,%s,%s,"' "$(qfield "$path")" "$(qfield "$title")" "$(qfield "$themes")" "$(qfield "$keywords")" >> "$CSV"
  [ -n "$bodyfile" ] && sed 's/"/""/g' "$bodyfile" >> "$CSV"
  printf '"\n' >> "$CSV"
  rows=$((rows + 1))
done < "$INDEX"

rm -f "$DB"
sqlite3 "$DB" <<SQL
PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
-- porter unicode61: stemming (savings->save, lifting->lift, investing->invest) bridges vocabulary
-- gaps; remove_diacritics folds resume/resume, cafe/cafe. path is stored but not tokenized.
CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, title, themes, keywords, body, tokenize='porter unicode61 remove_diacritics 2');
.mode csv
.import '$CSV' notes
SQL

n="$(sqlite3 "$DB" 'SELECT count(*) FROM notes;')"
echo "built: $n rows indexed (fed $rows) -> ${DB/#$HOME/~}"
