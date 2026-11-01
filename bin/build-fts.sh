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
# Speed: this phase used to start several processes per row (basename, stat, shasum, cut). It now keeps the
# per-row rules in the shell loop with no process started (artifact and selected-root checks, exactly as
# before), and gets the file fingerprints from ONE stat over all eligible rows, the sidecar names from ONE
# perl run, and the sidecar fingerprints from ONE more stat; awk joins the answers.
US='|'   # printable on purpose: the sqlite3 CLI prints control characters as ^_ when the signatures are read back
SIGROWS="$STAGE/sigrows.tsv"; NEWSIG="$STAGE/newsig.tsv"; : > "$SIGROWS"; : > "$NEWSIG"
: > "$STAGE/keeprows.txt"
ELIGIBLE="$STAGE/eligible.tsv"; : > "$ELIGIBLE"
shopt -s nocasematch
while IFS=$'\t' read -r path title themes keywords; do
  [ -z "$path" ] || [ "${path:0:1}" = "#" ] && continue
  is_artifact "$path" && continue
  real="${path/#\~/$HOME}"
  inside=0
  for root in "${CANON[@]}"; do case "$real" in "$root"/*) inside=1; break ;; esac; done
  [ "$inside" = 1 ] || continue
  printf '%s\t%s\t%s\t%s\t%s\n' "$real" "$path" "$title" "$themes" "$keywords" >> "$ELIGIBLE"
done < "$INDEX"
shopt -u nocasematch
# a file that cannot be read gets no fingerprint (stat reports it on stderr, which is dropped), as before
SRCSTAT="$STAGE/srcstat.tsv"
cut -f1 "$ELIGIBLE" | tr '\n' '\0' | xargs -0 stat -f '%i:%z:%m:%c:%p:%Sf%t%N' > "$SRCSTAT" 2>/dev/null || true
# tests simulate online-only files with NB_TEST_DATALESS_LIST: those rows get the same flag text a real offloaded file has
if [ -n "${NB_TEST_DATALESS_LIST:-}" ] && [ -s "$NB_TEST_DATALESS_LIST" ]; then
  awk -F'\t' 'NR == FNR { sim[$0] = 1; next } { fp = $1; if (substr($0, length($1) + 2) in sim) sub(/:[^:]*$/, ":dataless", fp); print fp "\t" substr($0, length($1) + 2) }' "$NB_TEST_DATALESS_LIST" "$SRCSTAT" > "$SRCSTAT.sim" && mv "$SRCSTAT.sim" "$SRCSTAT"
fi
# rows that read an extract sidecar: everything but a local text note, and a text note that is offloaded (dataless)
NEEDSIDE="$STAGE/needside.txt"
awk -F'\t' 'FILENAME == ARGV[1] { fp[substr($0, index($0, "\t") + 1)] = substr($0, 1, index($0, "\t") - 1); next }
  { if (tolower($2) !~ /\.(md|txt|markdown)$/ || fp[$1] ~ /dataless/) print $2 }' "$SRCSTAT" "$ELIGIBLE" > "$NEEDSIDE"
SIDEHASH="$STAGE/sidehash.tsv"
/usr/bin/perl -MDigest::SHA=sha1_hex -ne 'chomp; print "$_\t", substr(sha1_hex($_), 0, 16), "\n"' "$NEEDSIDE" > "$SIDEHASH"
SIDESTAT="$STAGE/sidestat.tsv"
cut -f2 "$SIDEHASH" | awk -v dir="$EXTRACTED" '{ printf "%s/%s.txt\n", dir, $0 }' | tr '\n' '\0' | xargs -0 stat -f '%z:%m%t%N' > "$SIDESTAT" 2>/dev/null || true
KEEPROWS="$STAGE/keeprows.txt" EXTRACTED="$EXTRACTED" US="$US" NEWSIG="$NEWSIG" SIGROWS="$SIGROWS" awk -F'\t' '
  function rest(line,   k, i) { for (k = 0; k < 4; k++) { i = index(line, "\t"); line = substr(line, i + 1) } return line }
  FILENAME == ARGV[1] { i = index($0, "\t"); src[substr($0, i + 1)] = substr($0, 1, i - 1); next }
  FILENAME == ARGV[2] { i = index($0, "\t"); hash[substr($0, 1, i - 1)] = substr($0, i + 1); next }
  FILENAME == ARGV[3] { i = index($0, "\t"); side[substr($0, i + 1)] = substr($0, 1, i - 1); next }
  {
    keywords = rest($0)
    srcfp = ($1 in src) ? src[$1] : ""
    scfp = ""
    if ($2 in hash) { key = ENVIRON["EXTRACTED"] "/" hash[$2] ".txt"; scfp = (key in side) ? side[key] : "" }
    sig = $3 ENVIRON["US"] $4 ENVIRON["US"] keywords ENVIRON["US"] srcfp ENVIRON["US"] scfp
    print $2 "\t" sig > ENVIRON["NEWSIG"]
    print sig "\t" $2 "\t" $3 "\t" $4 "\t" keywords > ENVIRON["SIGROWS"]
    # a text note that is online-only now and has no extract sidecar cannot be read without downloading it: its search row from the earlier
    # index (made while the file was on this Mac) is kept as it is
    if (srcfp ~ /dataless/ && scfp == "" && tolower($2) ~ /\.(md|txt|markdown)$/) print $2 > ENVIRON["KEEPROWS"]
  }' "$SRCSTAT" "$SIDEHASH" "$SIDESTAT" "$ELIGIBLE"

# ---- Decide full vs incremental, then which rows changed and which are gone.
MODE=full
OLDSIG="$STAGE/oldsig.tsv"; : > "$OLDSIG"
if [ -f "$DB" ] && [ "${NB_FTS_FULL:-0}" != 1 ]; then
  if sqlite3 -readonly "$DB" 'SELECT count(*) FROM notes; SELECT count(*) FROM sig; SELECT count(*) FROM meta; SELECT sec FROM notes LIMIT 1;' >/dev/null 2>&1 && \
      sqlite3 -readonly -separator $'\t' "$DB" 'SELECT path, sig FROM sig;' > "$OLDSIG" 2>/dev/null; then
    MODE=incremental
  else
    : > "$OLDSIG"
  fi
fi
CHANGED="$STAGE/changed_paths.txt"; GONE="$STAGE/gone_paths.txt"; : > "$CHANGED"; : > "$GONE"
awk -F'\t' -v changed="$CHANGED" -v gone="$GONE" '
  FILENAME == ARGV[1] { old[$1] = substr($0, length($1) + 2); next }
  FILENAME == ARGV[2] { keep[$0] = 1; next }
  { seen[$1] = 1; if (($1 in keep) && ($1 in old)) next; if (!($1 in old) || old[$1] != substr($0, length($1) + 2)) print $1 > changed }
  END { for (p in old) if (!(p in seen)) print p > gone }
' "$OLDSIG" "$STAGE/keeprows.txt" "$NEWSIG"
CHANGED_ROWS="$STAGE/changed_rows.tsv"
awk -F'\t' 'FILENAME == ARGV[1] { c[$0] = 1; next } ($2 in c)' "$CHANGED" "$SIGROWS" > "$CHANGED_ROWS"

# ---- Phase 2 (heavy, unchanged logic): emit CSV rows for the changed/new rows only.
# Body files are streamed through sed (quotes doubled) between an opening and closing quote;
# sqlite's CSV importer stitches embedded newlines back into one field.
SIGCSV="$STAGE/sig.csv"; : > "$CSV"; : > "$SIGCSV"
rows=0
skipped_busy=0
# A file that changes while it is being read is read again, up to 3 times. If it keeps changing it is left out of this build (its old row is
# dropped, its signature is not recorded), so the next refresh sees it as new and reads it again. One busy file never fails the whole build.
copy_with_retries() {
  local attempt
  for attempt in 1 2 3; do
    "$@" && return 0
    [ "$attempt" -lt 3 ] && sleep 0.2
  done
  return 1
}
skip_busy_file() {
  skipped_busy=$((skipped_busy + 1))
  echo "build-fts: left out of this build (changed while being read, 3 tries); the next refresh reads it again: $1" >&2
  rm -f "$STAGE/body"
}
while IFS=$'\t' read -r sigv path title themes keywords; do
  [ -z "$path" ] || [ "${path:0:1}" = "#" ] && continue
  real="${path/#\~/$HOME}"
  # index.tsv is mutable derived state; it cannot grant access to a file outside selected roots.
  is_approved_source_file "$real" || continue
  bodyfile=""; sectioned=0; unreadable_text=0
  ext="${path##*.}"; ext="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"
  if { [ "$ext" = "md" ] || [ "$ext" = "txt" ] || [ "$ext" = "markdown" ]; } && [ -f "$real" ]; then
    # A dataless source may use its previously indexed sidecar, but a locally present
    # unreadable source is metadata-only: neither source bytes nor an older sidecar body
    # may enter FTS until a later refresh can screen the source itself.
    if nb_is_dataless "$real"; then
      :
    elif [ ! -r "$real" ]; then
      unreadable_text=1
    else
      copy_with_retries copy_approved_source "$real" "$STAGE/body" || {
        skip_busy_file "$path"
        continue
      }
      bodyfile="$STAGE/body"
    fi
  fi
  if [ -z "$bodyfile" ] && [ "$unreadable_text" -eq 0 ]; then
    hash="$(printf '%s' "$path" | shasum | cut -c1-16)"
    sc="$EXTRACTED/$hash.txt"
    if [ -e "$sc" ] || [ -L "$sc" ]; then
      copy_with_retries copy_verified_file "$sc" "$STAGE/body" || {
        skip_busy_file "$path"
        continue
      }
      fingerprint="$(stat -f '%i:%z:%m:%c' "$real" 2>/dev/null || true)"
      # A very large extract (a textbook or manual, over NB_SEARCH_BODY_MAX_BYTES) is indexed in sections of about NB_SECTION_CHARS characters, one search
      # row each (all with this path, the first with the labels). Search folds them into one hit that says which sections matched. The same source and
      # fingerprint checks apply as for any other extract. (SEARCH_BODY_MAX_BYTES matches CAP in extract.sh.)
      if [ "$(sed -n '1p' "$STAGE/body")" = "<!-- newbrain-extract source: $path -->" ] && \
          [ "$(sed -n '2p' "$STAGE/body")" = "<!-- newbrain-extract fingerprint: $fingerprint -->" ] && \
          [ -n "$fingerprint" ] && is_approved_source_file "$real" && \
          [ "$(stat -f '%i:%z:%m:%c' "$real" 2>/dev/null)" = "$fingerprint" ]; then
        bodyfile="$STAGE/body"
        [ "$(wc -c < "$STAGE/body" | tr -d ' ')" -gt "${NB_SEARCH_BODY_MAX_BYTES:-800000}" ] && sectioned=1
      else
        rm -f "$STAGE/body"
      fi
    fi
  fi
  if [ "$sectioned" = 1 ]; then
    # one row per section; sec = "N/M:first character" (the character is a position in the text databrain_read shows)
    /usr/bin/perl -CSDA -e '
      my ($f, $path, $title, $themes, $kw, $size) = @ARGV;
      open(my $h, "<", $f) or exit 1; local $/; my $raw = <$h>; close $h;
      $raw =~ s/\A<!-- newbrain-extract source: [^\n]+ -->\n<!-- newbrain-extract fingerprint: [^\n]+ -->\s*//;
      my $len = length $raw; my @b; my $s = 0;
      while ($s < $len) { my $e = $s + $size; if ($e >= $len) { $e = $len } else { my $i = rindex($raw, "\n", $e - 1); $e = $i + 1 if $i > $s + $size - 2000; } push @b, [$s, $e]; $s = $e; }
      my $m = @b; my $n = 0;
      sub qf { my $x = shift; $x =~ s/"/""/g; return "\"$x\""; }
      for my $r (@b) { $n++; my $body = substr($raw, $r->[0], $r->[1] - $r->[0]);
        print qf($path), ",", ($n == 1 ? qf($title) . "," . qf($themes) . "," . qf($kw) : "\"\",\"\",\"\""), ",", qf($body), ",", qf("$n/$m:$r->[0]"), "\n"; }
    ' "$bodyfile" "$path" "$title" "$themes" "$keywords" "${NB_SECTION_CHARS:-20000}" >> "$CSV" || echo "build-fts: could not split a large text into sections: $path" >&2
  else
    printf '%s,%s,%s,%s,"' "$(qfield "$path")" "$(qfield "$title")" "$(qfield "$themes")" "$(qfield "$keywords")" >> "$CSV"
    [ -n "$bodyfile" ] && sed 's/"/""/g' "$bodyfile" >> "$CSV"
    printf '",""\n' >> "$CSV"
  fi
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
CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, title, themes, keywords, body, sec UNINDEXED, tokenize='porter unicode61 remove_diacritics 2');
-- meta: how many rows are sections of a large text (search folds them into one hit only when there are some). sec is "N/M:first character", empty for a whole note.
CREATE TABLE meta(sections INTEGER);
-- sig: one signature per indexed row, so the next run can update only what changed.
CREATE TABLE sig(path TEXT, sig TEXT);
CREATE INDEX sig_path ON sig(path);
.mode csv
.import '$CSV' notes
.import '$SIGCSV' sig
SQL
fi
[ "$sql_ok" = 1 ] && { sqlite3 "$DB_TMP" "DELETE FROM meta; INSERT INTO meta SELECT count(*) FROM notes WHERE coalesce(sec, '') != '';" || sql_ok=0; }
if [ "$sql_ok" != 1 ]; then
  echo "build-fts: SQLite failed; the previous search index was preserved." >&2
  exit 1
fi

built_rows="$(sqlite3 "$DB_TMP" 'SELECT count(DISTINCT path) FROM notes;' 2>/dev/null)" || {
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
# French shadow index (build-fts-fr.sh): rebuilt only when the main index changed. It never fails this build, and a French index that
# could not be rebuilt is removed rather than left behind out of date (search only shows French rows the main index also has).
FR_DB="$(dirname "$DB")/fts_fr.db"
# OFF BY DEFAULT since 0.1.31 (the 0.1.30 blind test found no gain and four questions ranked worse): the code stays, NB_FR_INDEX=on turns it
# back on. With it off, a French index left by 0.1.30 is removed so it can never be merged into a search.
if [ "${NB_FR_INDEX:-off}" != on ]; then
  rm -f "$FR_DB"
elif [ "$MODE" != incremental ] || [ "$rows" -gt 0 ] || [ "$removed_paths" -gt 0 ] || [ ! -f "$FR_DB" ]; then
  NB_FTS_DB="$DB" bash "$ROOT/bin/build-fts-fr.sh" >/dev/null 2>&1 || rm -f "$FR_DB"
fi
if [ "$MODE" = incremental ]; then
  echo "fts mode: incremental — $rows row(s) re-read, $removed_paths path(s) removed, $((total_rows - changed_rows)) unchanged row(s) not opened"
else
  echo "fts mode: full"
fi
if [ "$skipped_busy" -gt 0 ]; then
  echo "fts skipped: $skipped_busy file(s) changed while being read and were left out; the next refresh reads them again"
fi
