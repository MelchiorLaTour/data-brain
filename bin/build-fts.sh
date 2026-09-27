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
#   - local text note (.md/.txt/.markdown, present, NOT iCloud-dataless) -> read a verified copy
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
MOC="${NB_MOC_DIR:-$ROOT/moc}"
INDEX="${NB_FTS_INDEX:-$MOC/index.tsv}"
EXTRACTED="${NB_EXTRACTED_DIR:-$MOC/extracted}"
DB="${NB_FTS_DB:-$MOC/fts.db}"
[ -f "$INDEX" ] || { echo "build-fts: no index.tsv at $INDEX" >&2; exit 1; }
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/databrain-fts.XXXXXX")"
CSV="$STAGE/corpus.csv"
mkdir -p "$(dirname "$DB")"
DB_TMP="$(mktemp "${DB}.tmp.XXXXXX")"
trap 'rm -rf "$STAGE"; rm -f "$DB_TMP"' EXIT

# Sidecars are derived files in the selected DataBrain state directory. A replaced
# directory or symlink is not an authorized source of text for the search index.
if [ -e "$EXTRACTED" ] || [ -L "$EXTRACTED" ]; then
  [ -d "$EXTRACTED" ] && [ ! -L "$EXTRACTED" ] && \
    [ "$(cd -P "$EXTRACTED" 2>/dev/null && pwd -P)" = "$EXTRACTED" ] || {
      echo 'build-fts: extracted text directory is unsafe; previous search index preserved.' >&2
      exit 2
    }
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
  # index.tsv is mutable derived state; it cannot grant access to a file outside selected roots.
  is_approved_source_file "$real" || continue
  bodyfile=""
  ext="${path##*.}"; ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
  if { [ "$ext" = "md" ] || [ "$ext" = "txt" ] || [ "$ext" = "markdown" ]; } && [ -f "$real" ] && [ -r "$real" ]; then
    # local text note — but skip if offloaded (dataless): reading it would force a download.
    flags="$(stat -f '%Sf' "$real" 2>/dev/null || true)"
    case "$flags" in
      *dataless*) : ;;
      *)
        copy_approved_source "$real" "$STAGE/body" || {
          echo 'build-fts: approved source changed during read; previous search index preserved.' >&2
          exit 2
        }
        bodyfile="$STAGE/body"
        ;;
    esac
  fi
  if [ -z "$bodyfile" ]; then
    hash="$(printf '%s' "$path" | shasum | cut -c1-16)"
    sc="$EXTRACTED/$hash.txt"
    if [ -e "$sc" ] || [ -L "$sc" ]; then
      copy_verified_file "$sc" "$STAGE/body" || {
        echo 'build-fts: extracted text changed during read; previous search index preserved.' >&2
        exit 2
      }
      fingerprint="$(stat -f '%i:%z:%m:%c' "$real" 2>/dev/null || true)"
      if [ "$(sed -n '1p' "$STAGE/body")" = "<!-- newbrain-extract source: $path -->" ] && \
          [ "$(sed -n '2p' "$STAGE/body")" = "<!-- newbrain-extract fingerprint: $fingerprint -->" ] && \
          [ -n "$fingerprint" ] && is_approved_source_file "$real" && \
          [ "$(stat -f '%i:%z:%m:%c' "$real" 2>/dev/null)" = "$fingerprint" ]; then
        bodyfile="$STAGE/body"
      else
        rm -f "$STAGE/body"
      fi
    fi
  fi
  printf '%s,%s,%s,%s,"' "$(qfield "$path")" "$(qfield "$title")" "$(qfield "$themes")" "$(qfield "$keywords")" >> "$CSV"
  [ -n "$bodyfile" ] && sed 's/"/""/g' "$bodyfile" >> "$CSV"
  printf '"\n' >> "$CSV"
  rm -f "$STAGE/body"
  rows=$((rows + 1))
done < "$INDEX"

if ! sqlite3 "$DB_TMP" <<SQL
PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
-- porter unicode61: stemming (savings->save, lifting->lift, investing->invest) bridges vocabulary
-- gaps; remove_diacritics folds resume/resume, cafe/cafe. path is stored but not tokenized.
CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, title, themes, keywords, body, tokenize='porter unicode61 remove_diacritics 2');
.mode csv
.import '$CSV' notes
SQL
then
  echo "build-fts: SQLite failed; the previous search index was preserved." >&2
  exit 1
fi

built_rows="$(sqlite3 "$DB_TMP" 'SELECT count(*) FROM notes;' 2>/dev/null)" || {
  echo "build-fts: could not verify the new search index; the previous search index was preserved." >&2
  exit 1
}
case "$built_rows" in ''|*[!0-9]*)
  echo "build-fts: invalid row count from the new search index; the previous search index was preserved." >&2
  exit 1
  ;;
esac
if [ "$built_rows" -ne "$rows" ]; then
  echo "build-fts: expected $rows rows but the new index contains $built_rows; the previous search index was preserved." >&2
  exit 1
fi
mv -f "$DB_TMP" "$DB"
DB_TMP=""
echo "built: $built_rows rows indexed (fed $rows) -> ${DB/#$HOME/~}"
