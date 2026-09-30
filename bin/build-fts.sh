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
# INCREMENTAL (plan 11): every row gets a cheap signature (labels + source fingerprint + extract
# sidecar fingerprint), stored in a side table `sig` inside fts.db. A rerun opens only rows whose
# signature is new or different, deletes changed + removed rows, and imports the changed ones into a
# COPY of the DB that then replaces the old one atomically. A DB without `sig` (older build), a
# missing DB, or NB_FTS_FULL=1 means one full rebuild, which also creates `sig`.
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

# ---- Phase 1 (cheap, every row): one signature per eligible row. Unchanged rows are never opened.
# Same eligibility as before: artifacts and rows outside the selected roots are skipped here; the
# full canonical-path check still runs (below) for every row whose body is actually read.
US='|'   # printable on purpose: the sqlite3 CLI prints control characters as ^_ when the signatures are read back
SIGROWS="$STAGE/sigrows.tsv"; NEWSIG="$STAGE/newsig.tsv"; : > "$SIGROWS"; : > "$NEWSIG"
shopt -s nocasematch
while IFS=$'\t' read -r path title themes keywords; do
  [ -z "$path" ] || [ "${path:0:1}" = "#" ] && continue
  is_artifact "$path" && continue
  real="${path/#\~/$HOME}"
  inside=0
  for root in "${CANON[@]}"; do case "$real" in "$root"/*) inside=1; break ;; esac; done
  [ "$inside" = 1 ] || continue
  srcfp="$(stat -f '%i:%z:%m:%c:%Sf' "$real" 2>/dev/null || true)"
  scfp=""
  case "$path" in
    *.md|*.txt|*.markdown) case "$srcfp" in *dataless*) scfp="sidecar" ;; esac ;;
    *) scfp="sidecar" ;;
  esac
  if [ -n "$scfp" ]; then
    hash="$(printf '%s' "$path" | shasum | cut -c1-16)"
    scfp="$(stat -f '%z:%m' "$EXTRACTED/$hash.txt" 2>/dev/null || true)"
  fi
  sig="$title$US$themes$US$keywords$US$srcfp$US$scfp"
  printf '%s\t%s\n' "$path" "$sig" >> "$NEWSIG"
  printf '%s\t%s\t%s\t%s\t%s\n' "$sig" "$path" "$title" "$themes" "$keywords" >> "$SIGROWS"
done < "$INDEX"
shopt -u nocasematch

# ---- Decide full vs incremental, then which rows changed and which are gone.
MODE=full
OLDSIG="$STAGE/oldsig.tsv"; : > "$OLDSIG"
if [ -f "$DB" ] && [ "${NB_FTS_FULL:-0}" != 1 ]; then
  if sqlite3 -readonly "$DB" 'SELECT count(*) FROM notes; SELECT count(*) FROM sig;' >/dev/null 2>&1 && \
      sqlite3 -readonly -separator $'\t' "$DB" 'SELECT path, sig FROM sig;' > "$OLDSIG" 2>/dev/null; then
    MODE=incremental
  else
    : > "$OLDSIG"
  fi
fi
CHANGED="$STAGE/changed_paths.txt"; GONE="$STAGE/gone_paths.txt"; : > "$CHANGED"; : > "$GONE"
awk -F'\t' -v changed="$CHANGED" -v gone="$GONE" '
  FILENAME == ARGV[1] { old[$1] = substr($0, length($1) + 2); next }
  { seen[$1] = 1; if (!($1 in old) || old[$1] != substr($0, length($1) + 2)) print $1 > changed }
  END { for (p in old) if (!(p in seen)) print p > gone }
' "$OLDSIG" "$NEWSIG"
CHANGED_ROWS="$STAGE/changed_rows.tsv"
awk -F'\t' 'FILENAME == ARGV[1] { c[$0] = 1; next } ($2 in c)' "$CHANGED" "$SIGROWS" > "$CHANGED_ROWS"

# ---- Phase 2 (heavy, unchanged logic): emit CSV rows for the changed/new rows only.
# Body files are streamed through sed (quotes doubled) between an opening and closing quote;
# sqlite's CSV importer stitches embedded newlines back into one field.
SIGCSV="$STAGE/sig.csv"; : > "$CSV"; : > "$SIGCSV"
rows=0
while IFS=$'\t' read -r sigv path title themes keywords; do
  [ -z "$path" ] || [ "${path:0:1}" = "#" ] && continue
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
  printf '%s,%s\n' "$(qfield "$path")" "$(qfield "$sigv")" >> "$SIGCSV"
  rm -f "$STAGE/body"
  rows=$((rows + 1))
done < "$CHANGED_ROWS"

total_rows="$(wc -l < "$NEWSIG" | tr -d ' ')"
changed_rows="$(wc -l < "$CHANGED_ROWS" | tr -d ' ')"
expected=$(( total_rows - changed_rows + rows ))
removed_paths="$(wc -l < "$GONE" | tr -d ' ')"

if [ "$MODE" = incremental ]; then
  DROP="$STAGE/drop.csv"
  cat "$CHANGED" "$GONE" | awk '{ gsub(/"/, "\"\""); print "\"" $0 "\"" }' > "$DROP"
  cp -p "$DB" "$DB_TMP" || { echo "build-fts: could not copy the previous search index; it was preserved." >&2; exit 1; }
  sql_ok=1
  sqlite3 "$DB_TMP" <<SQL || sql_ok=0
PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
CREATE TEMP TABLE drop_paths(path TEXT);
.mode csv
.import '$DROP' drop_paths
DELETE FROM notes WHERE path IN (SELECT path FROM drop_paths);
DELETE FROM sig WHERE path IN (SELECT path FROM drop_paths);
.import '$CSV' notes
.import '$SIGCSV' sig
SQL
else
  sql_ok=1
  sqlite3 "$DB_TMP" <<SQL || sql_ok=0
PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
-- porter unicode61: stemming (savings->save, lifting->lift, investing->invest) bridges vocabulary
-- gaps; remove_diacritics folds resume/resume, cafe/cafe. path is stored but not tokenized.
CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, title, themes, keywords, body, tokenize='porter unicode61 remove_diacritics 2');
-- sig: one signature per indexed row, so the next run can update only what changed.
CREATE TABLE sig(path TEXT, sig TEXT);
CREATE INDEX sig_path ON sig(path);
.mode csv
.import '$CSV' notes
.import '$SIGCSV' sig
SQL
fi
if [ "$sql_ok" != 1 ]; then
  echo "build-fts: SQLite failed; the previous search index was preserved." >&2
  exit 1
fi

built_rows="$(sqlite3 "$DB_TMP" 'SELECT count(*) FROM notes;' 2>/dev/null)" || {
  echo "build-fts: could not verify the new search index; the previous search index was preserved." >&2
  exit 1
}
sig_rows="$(sqlite3 "$DB_TMP" 'SELECT count(*) FROM sig;' 2>/dev/null)" || sig_rows=""
case "$built_rows" in ''|*[!0-9]*)
  echo "build-fts: invalid row count from the new search index; the previous search index was preserved." >&2
  exit 1
  ;;
esac
if [ "$built_rows" -ne "$expected" ] || [ "$sig_rows" != "$built_rows" ]; then
  echo "build-fts: expected $expected rows but the new index contains $built_rows (signatures: ${sig_rows:-none}); the previous search index was preserved." >&2
  exit 1
fi
mv -f "$DB_TMP" "$DB"
DB_TMP=""
echo "built: $built_rows rows indexed (fed $expected) -> ${DB/#$HOME/~}"
if [ "$MODE" = incremental ]; then
  echo "fts mode: incremental — $rows row(s) re-read, $removed_paths path(s) removed, $((total_rows - changed_rows)) unchanged row(s) not opened"
else
  echo "fts mode: full"
fi
