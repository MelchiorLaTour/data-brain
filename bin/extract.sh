#!/usr/bin/env bash
# extract.sh — Phase 1 shelf-filler. Makes binary + iCloud-offloaded notes FULL-TEXT searchable
# WITHOUT copying or moving the originals. For each pdf/docx/doc/pages/rtf row in index.tsv — plus
# any md/txt row whose file is currently iCloud-OFFLOADED or lacks search keywords — it:
#   1. READS the file (reading auto-DOWNLOADS an offloaded original on access; a read is the trigger),
#   2. extracts plaintext into moc/extracted/<hash>.txt — a derived, rebuildable sidecar. NO copy of
#      the original is kept,
#   2b. if the file WAS offloaded, immediately `brctl evict`s it back to dataless — so the pass is
#      true file-by-file (download -> write extract -> re-offload), peak local disk ~one file, never
#      a whole room. (`brctl evict` works on Darwin 25; hidden from --help, verified 2026-06-28.)
#   3. fills the KEYWORDS column in index.tsv from readable content (pure-bash top terms),
#      ONLY when it is still '-' — never clobbers the hand-seeded or path-derived labels.
# search.sh gets a pass over moc/extracted/, so these notes become full-text searchable.
#
# Claude-OFF: local PDFKit / pdftotext / textutil / pandoc extractors; no network, no API.
# NO COPY / NEVER MOVE-RENAME: the original is only READ; the only writes are NewBrain's own
#   moc/extracted/*.txt and moc/index.tsv (keywords col). Re-runnable + idempotent (stable hash per
#   path; skips files that already have a non-empty extract unless --force).
# BATCHED to keep peak disk low — process a slice at a time:
#   bin/extract.sh --room school --limit 100     # high-value offloaded rooms first
#   bin/extract.sh --limit 200                    # next slice
#   bin/extract.sh --force --room writing         # re-extract a room
#   bin/extract.sh --paths FILE                   # only the rows whose path (column 1, as in index.tsv) is listed in FILE, one per line;
#                                                 # the other rows are not even looked at, and their report lines are kept as they are
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
MOC="${NB_MOC_DIR:-$ROOT/moc}"
INDEX="$MOC/index.tsv"
EXDIR="$MOC/extracted"
[ -s "$INDEX" ] || { echo "error: $INDEX missing/empty" >&2; exit 1; }
mkdir -p "$EXDIR"

ROOM=""; LIMIT=0; FORCE=0; PATHS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --room)  ROOM="${2:-}"; shift 2 ;;
    --limit) LIMIT="${2:-0}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --paths) PATHS="${2:-}"; shift 2 ;;
    *) echo "usage: extract.sh [--room NAME] [--limit N] [--force] [--paths FILE]" >&2; exit 1 ;;
  esac
done

# Two size limits (0.1.30). Until then one cap, CAP=800000 characters, decided both things: a text larger than it was a
# textbook/manual, not a personal note, and its multi-MB text drowns real notes in ranked search, so it got NO extract at all
# (title and keywords only) and Claude could not read it. Now:
#   - SEARCH BODY: still 800000 characters (build-fts.sh keeps a larger extract OUT of the ranked search body, same reason as before;
#     the file is still found by its title and keywords). Measured cliff: the 17 known textbooks are all >1.05MB; the largest real
#     note extract is ~471KB.
#   - READ CEILING: READ_CEILING characters. A text up to it is extracted in full, so databrain_read can read a long PDF or Word file to
#     its end. Only a text larger than the ceiling is still title-and-keywords-only.
CAP=800000
READ_CEILING="${NB_READ_CEILING:-20000000}"   # NB_READ_CEILING: a test hook

tmpd="$(mktemp -d)"
out_tmp=""
index_stage=""
privacy_enabled=0
[ -n "${NB_PRIVACY_FILE:-}" ] && privacy_enabled=1
pending_sidecars=()
pending_removals=()
pending_sidecars_count=0
pending_removals_count=0
kill_tree() { local c; for c in $(/usr/bin/pgrep -P "$1" 2>/dev/null); do kill_tree "$c"; done; kill -TERM "$1" 2>/dev/null; }
cleanup() {
  trap '' TERM INT HUP
  [ -z "${WATCH:-}" ] || kill "$WATCH" 2>/dev/null
  local child
  for child in $(/usr/bin/pgrep -P $$ 2>/dev/null); do kill_tree "$child"; done   # an extractor still running (osascript, textutil...) must not outlive this script
  [ -z "$out_tmp" ] || rm -f -- "$out_tmp"
  [ -z "$index_stage" ] || rm -f -- "$index_stage"
  rm -rf "$tmpd"
}
trap cleanup EXIT
# Bash runs a trap only when its foreground command ends or at a `wait`, so the extractor below runs in the background and is waited for.
trap 'exit 143' TERM INT HUP
# If the program that started this script is gone (killed without a chance to clean up), stop the whole group of this run. Only a script that
# leads its own process group does this; one started by hand from a terminal does not.
PARENT_PID=$PPID
if [ "$(ps -o pgid= -p $$ | tr -d ' ')" = "$$" ]; then
  ( while kill -0 "$PARENT_PID" 2>/dev/null; do sleep 1; done; kill -TERM -- "-$$" 2>/dev/null ) >/dev/null 2>&1 &
  WATCH=$!
fi
STOP="$tmpd/stop"; KWUP="$tmpd/kwupdates"; : > "$KWUP"
REPORT_TMP="$tmpd/extract-report.tsv"
printf '# canonical_path\tstatus\n' > "$REPORT_TMP"
# Pure-bash stopword list (EN + a few FR + the owner's name, the #1 header/footer pollutant) so
# keyword extraction stays Claude-OFF. Short (<4 char) words are already dropped below.
# EDIT: replace the two placeholder tokens with your own first/last name (lowercase).
printf '%s\n' \
  this that with from have were your you our their them they will would there here what when which \
  into over under about above been being also only just more most some such than then these those \
  page pages http https www com docx file files note notes yourfirstname yourlastname \
  pour avec dans les des une sur est sont être cette mais plus tout nous vous leur \
  > "$STOP"

# pdftotext or the macOS PDFKit bridge / textutil/pandoc dispatch -> plaintext on stdout.
extract_text() {
  local f="$1" ext="$2" t=""
  case "$ext" in
    pdf)
      # The subshell hides the extractor's exit status, so keep it in a file: empty text with status 0 is a scanned image, not a read error.
      rm -f "$tmpd/pdfrc"
      if command -v pdftotext >/dev/null 2>&1; then
        t="$(limit pdftotext -q "$f" - 2>/dev/null)"; printf '%s' "$?" > "$tmpd/pdfrc"
      elif [ -x /usr/bin/osascript ] && [ -f "$ROOT/setup/mcp/pdf-extract.js" ]; then
        t="$(limit /usr/bin/osascript -l JavaScript "$ROOT/setup/mcp/pdf-extract.js" "$f" 2>/dev/null)"; printf '%s' "$?" > "$tmpd/pdfrc"
      fi
      ;;
    docx|doc|rtf)    t="$(limit textutil -convert txt -stdout "$f" 2>/dev/null)"
                     [ -n "$t" ] || t="$(limit pandoc -t plain "$f" 2>/dev/null)" ;;
    pages)           t="$(limit textutil -convert txt -stdout "$f" 2>/dev/null)"
                     [ -n "$t" ] || t="$(limit pandoc -t plain "$f" 2>/dev/null)" ;;
    md|markdown|txt) t="$(cat "$f" 2>/dev/null)" ;;
  esac
  printf '%s' "$t"
}

# Top content terms (4-20 chars, minus stopwords + bare years), comma-joined, max 8.
# Bare-year tokens (1900-2099) are dropped: they collide across resumes/tax docs/coursework and
# poison year queries (Step 4 keyword-backfill finding, 2026-07-05).
derive_keywords() {
  printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '\n' \
    | awk 'length($0)>=4 && length($0)<=20 && $0 !~ /^(19|20)[0-9][0-9]$/' \
    | grep -vwF -f "$STOP" \
    | sort | uniq -c | sort -rn | awk 'NR<=8{print $2}' | paste -sd, -
}

is_offloaded() { nb_is_dataless "$1"; }

# Per-file time limit so one bad or offline file is recorded as failed instead of freezing setup.
EXTRACT_TIMEOUT="${NB_EXTRACT_TIMEOUT:-120}"
limit() { /usr/bin/perl -e 'alarm shift; exec @ARGV' "$EXTRACT_TIMEOUT" "$@"; }

# --paths: loop over just the listed rows (one awk pass), instead of every row of the index.
LOOP_INPUT="$INDEX"
if [ -n "$PATHS" ]; then
  [ -f "$PATHS" ] || { echo "extract: --paths file not found" >&2; exit 1; }
  LOOP_INPUT="$tmpd/subset.tsv"
  awk -F'\t' 'NR==FNR { want[$1]=1; next } /^#/ { next } ($1 in want)' "$PATHS" "$INDEX" > "$LOOP_INPUT"
fi

held=0; processed=0; extracted=0; keyword_only=0; skipped_fresh=0; failed=0; downloaded=0; evicted=0; titled_only=0; no_text=0; seen=0
# Progress file: "<files really extracted this run> <earlier results reused> <rows looked at>". Real work and re-checked rows are
# kept apart, so a resumed run does not count files it only re-checked and skipped as work done.
write_progress() { printf '%s %s %s\n' "$processed" "$skipped_fresh" "$seen" > "$MOC/extract-progress.txt"; }
while IFS=$'\t' read -r path title themes keywords; do
  case "$path" in \#*|"") continue ;; esac
  seen=$((seen+1))
  [ $((seen % 25)) -eq 0 ] && write_progress
  case "$path" in *Resources/Sensitive/*) continue ;; esac   # hard-blocked set, defensive
  f="${path/#\~/$HOME}"
  if ! is_approved_source_path "$f" || [ -L "$f" ]; then
    failed=$((failed+1)); printf '%s\tunsafe_path\n' "$path" >> "$REPORT_TMP"; continue
  fi
  base="$(basename "$f")"; ext="$(printf '%s' "${base##*.}" | tr 'A-Z' 'a-z')"
  room="${themes%%,*}"
  select_keywords_only=0

  # Extract binary formats and offloaded text. For local text, read only when keywords are absent;
  # FTS already indexes the original body, so no duplicate sidecar is needed.
  case "$ext" in
    pdf|docx|doc|pages|rtf) : ;;
    md|markdown|txt)
      if [ -e "$f" ] && is_offloaded "$f"; then
        :
      elif [ "$keywords" = "-" ] || [ -z "$keywords" ]; then
        select_keywords_only=1
      else
        continue
      fi
      ;;
    *) continue ;;
  esac
  [ -n "$ROOM" ] && [ "$room" != "$ROOM" ] && continue
  [ -e "$f" ] || { failed=$((failed+1)); printf '%s\tmissing\n' "$path" >> "$REPORT_TMP"; continue; }
  # A file that is online-only (it was indexed while it was on this Mac and macOS has since offloaded it) is NEVER opened here: reading it would
  # download it. Whatever was indexed stays as it is (its sidecar, if it has one, and its search row) and it is counted, not treated as a failure.
  if is_offloaded "$f"; then
    # already indexed while it was on this Mac (an extract sidecar, or a search row with text)? Then leave it exactly as it is. A file never
    # indexed before (first setup of an offloaded note) keeps the older route: read once, extract, put it back.
    sc_hash="$(printf '%s' "$path" | shasum | cut -c1-16)"
    if [ -s "$EXDIR/$sc_hash.txt" ] || [ "$(sqlite3 -readonly "$MOC/fts.db" "SELECT 1 FROM notes WHERE path = '${path//\'/\'\'}' AND length(body) > 0 LIMIT 1;" 2>/dev/null)" = 1 ]; then
      printf '%s\tcloud_only\n' "$path" >> "$REPORT_TMP"; continue
    fi
  fi

  hash="$(printf '%s' "$path" | shasum | cut -c1-16)"
  out="$EXDIR/$hash.txt"
  # stat uses lstat semantics here. Once the file is opened below, comparing its
  # inode with /dev/fd/9 rejects a symlink swap between this check and open.
  fingerprint="$(stat -f '%i:%z:%m:%c' "$f" 2>/dev/null || true)"
  if [ -z "$fingerprint" ]; then failed=$((failed+1)); printf '%s\tstat_failed\n' "$path" >> "$REPORT_TMP"; continue; fi
  case "$ext" in
    md|markdown|txt)
      if [ "$privacy_enabled" -eq 1 ] && [ ! -r "$f" ]; then
        # Keep the metadata row, but neither inspect an old sidecar nor publish a body
        # when the local text source cannot be screened. A later refresh retries it.
        processed=$((processed+1)); failed=$((failed+1))
        printf '%s\topen_failed\n' "$path" >> "$REPORT_TMP"
        continue
      fi
      ;;
  esac
  if [ "$select_keywords_only" -eq 0 ] && [ "$FORCE" -eq 0 ] && [ -s "$out" ] \
      && [ "$(sed -n '1p' "$out")" = "<!-- newbrain-extract source: $path -->" ] \
      && [ "$(sed -n '2p' "$out")" = "<!-- newbrain-extract fingerprint: $fingerprint -->" ]; then
    if [ "$privacy_enabled" -eq 1 ]; then
      if ! cached_text="$(cat "$out")"; then
        if ! rm -f -- "$out"; then echo "extract: cached extract read and cleanup both failed" >&2; exit 2; fi
        echo "extract: cannot read cached extract for $path; stopping before publishing updates" >&2
        exit 2
      fi
      if why="$(printf '%s' "$cached_text" | /usr/bin/perl "$ROOT/bin/privacy.pl" content "$f")"; then
        privacy_status=0
      else
        privacy_status=$?
      fi
      if [ "$privacy_status" -ne 0 ]; then
        if ! rm -f -- "$out"; then echo "extract: privacy screen failed and cached extract cleanup also failed" >&2; exit 2; fi
        echo "extract: privacy screen failed for $path; stopping before publishing updates" >&2
        exit 2
      fi
      if [ -n "$why" ]; then
        if ! rm -f -- "$out"; then echo "extract: held cached extract could not be removed" >&2; exit 2; fi
        held=$((held+1)); printf '%s\theld_private\n' "$path" >> "$REPORT_TMP"
        continue
      fi
    fi
    skipped_fresh=$((skipped_fresh+1)); printf '%s\tcached\n' "$path" >> "$REPORT_TMP"; continue
  fi
  [ "$LIMIT" -gt 0 ] && [ "$processed" -ge "$LIMIT" ] && break
  processed=$((processed+1))

  was_off=0; if is_offloaded "$f"; then was_off=1; downloaded=$((downloaded+1)); fi
  if ! exec 9<"$f"; then
    failed=$((failed+1)); printf '%s\topen_failed\n' "$path" >> "$REPORT_TMP"; continue
  fi
  opened_fingerprint="$(fd9_fingerprint || true)"
  if [ "$opened_fingerprint" != "$fingerprint" ]; then
    exec 9<&-
    failed=$((failed+1)); printf '%s\tsource_changed_before_open\n' "$path" >> "$REPORT_TMP"; continue
  fi
  staged_source="$tmpd/source.$ext"
  if ! limit cat /dev/fd/9 > "$staged_source"; then
    exec 9<&-
    failed=$((failed+1)); printf '%s\tread_failed\n' "$path" >> "$REPORT_TMP"; continue
  fi
  after_copy_fd="$(fd9_fingerprint || true)"
  after_copy_path="$(stat -f '%i:%z:%m:%c' "$f" 2>/dev/null || true)"
  exec 9<&-
  if [ "$after_copy_fd" != "$opened_fingerprint" ] || [ "$after_copy_path" != "$opened_fingerprint" ]; then
    failed=$((failed+1)); printf '%s\tsource_changed_during_copy\n' "$path" >> "$REPORT_TMP"; continue
  fi
  extract_text "$staged_source" "$ext" > "$tmpd/text.out" &
  wait $!
  if text="$(cat "$tmpd/text.out")"; then
    text_read_status=0
  else
    text_read_status=$?
  fi
  if [ "$text_read_status" -ne 0 ] && [ "$privacy_enabled" -eq 1 ]; then
    echo "extract: cannot read extracted text for $path; stopping before publishing updates" >&2
    exit 2
  fi
  after_fingerprint="$(stat -f '%i:%z:%m:%c' "$f" 2>/dev/null || true)"
  if [ "$after_fingerprint" != "$opened_fingerprint" ]; then
    failed=$((failed+1)); printf '%s\tsource_changed_during_extraction\n' "$path" >> "$REPORT_TMP"; continue
  fi
  # Re-evict only after proving the approved pathname still names the opened file.
  if [ "$was_off" -eq 1 ]; then brctl evict "$f" >/dev/null 2>&1 && evicted=$((evicted+1)); fi
  if [ -z "$text" ]; then
    if [ "$select_keywords_only" -eq 1 ]; then
      printf '%s\tkeywords_unavailable\n' "$path" >> "$REPORT_TMP"
      continue
    fi
    if [ "$privacy_enabled" -eq 1 ]; then pending_removals+=("$out"); pending_removals_count=$((pending_removals_count+1)); else rm -f -- "$out"; fi
    if [ "$ext" = pdf ] && [ "$(cat "$tmpd/pdfrc" 2>/dev/null)" = 0 ]; then
      no_text=$((no_text+1)); printf '%s\tno_text_layer\n' "$path" >> "$REPORT_TMP"; continue   # scanned image: opened fine, nothing to read (no OCR)
    fi
    failed=$((failed+1)); printf '%s\textraction_failed\n' "$path" >> "$REPORT_TMP"; continue
  fi

  # Privacy screen on the extracted text, before it can reach the index: a clear private pattern
  # (IBAN, card, social security number, private key) puts the file on the held list instead.
  if [ -n "${NB_PRIVACY_FILE:-}" ]; then
    if why="$(printf '%s' "$text" | /usr/bin/perl "$ROOT/bin/privacy.pl" content "$f")"; then
      privacy_status=0
    else
      privacy_status=$?
    fi
    if [ "$privacy_status" -ne 0 ]; then
      echo "extract: privacy screen failed for $path; stopping before publishing updates" >&2
      exit 2
    fi
    if [ -n "$why" ]; then
      if ! rm -f -- "$out"; then echo "extract: held cached extract could not be removed" >&2; exit 2; fi
      held=$((held+1)); printf '%s\theld_private\n' "$path" >> "$REPORT_TMP"; continue
    fi
  fi

  if [ "$select_keywords_only" -eq 1 ]; then
    kw="$(derive_keywords "$text")"
    if [ -n "$kw" ]; then
      printf '%s\t%s\n' "$path" "$kw" >> "$KWUP"
      keyword_only=$((keyword_only+1))
      printf '%s\tkeywords_selected\n' "$path" >> "$REPORT_TMP"
    else
      printf '%s\tkeywords_unavailable\n' "$path" >> "$REPORT_TMP"
    fi
    continue
  fi

  # read ceiling: a text this large is not extracted (keep keywords). Anything smaller is written in full; build-fts.sh decides
  # whether its body is searched (see CAP above).
  if [ "${#text}" -gt "$READ_CEILING" ]; then
    if [ "$privacy_enabled" -eq 1 ]; then pending_removals+=("$out"); pending_removals_count=$((pending_removals_count+1)); else rm -f -- "$out"; fi
    if [ "$keywords" = "-" ] || [ -z "$keywords" ]; then
      kw="$(derive_keywords "$text")"
      [ -n "$kw" ] && printf '%s\t%s\n' "$path" "$kw" >> "$KWUP"
    fi
    titled_only=$((titled_only+1))
    printf '%s\ttitle_and_keywords_only\n' "$path" >> "$REPORT_TMP"
    continue
  fi

  # write the derived extract with a source header so a search hit traces back to the real file
  if [ "$privacy_enabled" -eq 1 ]; then
    if ! out_tmp="$(mktemp "$tmpd/sidecar.XXXXXX")"; then
      echo "extract: cannot stage extract for $path" >&2; exit 2
    fi
  else
    out_tmp="$(mktemp "${out}.tmp.XXXXXX")"
  fi
  if [ "$privacy_enabled" -eq 1 ]; then
    if ! { printf '<!-- newbrain-extract source: %s -->\n' "$path" && printf '<!-- newbrain-extract fingerprint: %s -->\n\n' "$fingerprint" && printf '%s\n' "$text"; } > "$out_tmp"; then
      rm -f -- "$out_tmp"; out_tmp=""
      echo "extract: cannot write staged extract for $path" >&2; exit 2
    fi
    pending_sidecars+=("$out_tmp" "$out")
    pending_sidecars_count=$((pending_sidecars_count+2))
  else
    { printf '<!-- newbrain-extract source: %s -->\n' "$path"; printf '<!-- newbrain-extract fingerprint: %s -->\n\n' "$fingerprint"; printf '%s\n' "$text"; } > "$out_tmp"
    mv -f -- "$out_tmp" "$out"
  fi
  out_tmp=""
  extracted=$((extracted+1))
  printf '%s\textracted\n' "$path" >> "$REPORT_TMP"

  # queue a keyword fill (applied in one awk pass below) only if the row has none yet
  if [ "$keywords" = "-" ] || [ -z "$keywords" ]; then
    kw="$(derive_keywords "$text")"
    [ -n "$kw" ] && printf '%s\t%s\n' "$path" "$kw" >> "$KWUP"
  fi
done < "$LOOP_INPUT"

if [ "$privacy_enabled" -eq 1 ]; then
  # Apply keyword and hold changes to a same-directory index stage. No extracted bytes,
  # keywords, or index rows from this run are published unless pruning succeeds.
  index_stage="$(mktemp "${INDEX}.extract.XXXXXX")"
  if ! cp "$INDEX" "$index_stage"; then echo "extract: cannot stage index $INDEX" >&2; exit 2; fi
  if [ -s "$KWUP" ]; then
    if ! awk -F'\t' -v OFS='\t' '
      NR==FNR { upd[$1]=$2; next }
      /^#/    { print; next }
      { if (($1 in upd) && ($4=="-" || $4=="")) $4=upd[$1]; print }
    ' "$KWUP" "$index_stage" > "$tmpd/index.updated"; then
      echo "extract: cannot stage keyword updates" >&2; exit 2
    fi
    if ! mv -f -- "$tmpd/index.updated" "$index_stage"; then echo "extract: cannot stage keyword updates" >&2; exit 2; fi
  fi
  if ! /usr/bin/perl "$ROOT/bin/privacy.pl" prune-index "$index_stage"; then
    echo "extract: privacy index pruning failed; stopping before publishing updates" >&2
    exit 2
  fi
  for ((i=0; i<pending_removals_count; i++)); do
    if ! rm -f -- "${pending_removals[i]}"; then echo "extract: cannot remove stale extract ${pending_removals[i]}" >&2; exit 2; fi
  done
  for ((i=0; i<pending_sidecars_count; i+=2)); do
    if ! mv -f -- "${pending_sidecars[i]}" "${pending_sidecars[i+1]}"; then
      echo "extract: cannot publish extract ${pending_sidecars[i+1]}" >&2; exit 2
    fi
  done
  if ! mv -f -- "$index_stage" "$INDEX"; then echo "extract: cannot publish index $INDEX" >&2; exit 2; fi
  index_stage=""
else
  # Single pass: fill keywords col (col4) for queued paths whose current value is still '-'.
  if [ -s "$KWUP" ]; then
    awk -F'\t' -v OFS='\t' '
      NR==FNR { upd[$1]=$2; next }
      /^#/    { print; next }
      { if (($1 in upd) && ($4=="-" || $4=="")) $4=upd[$1]; print }
    ' "$KWUP" "$INDEX" > "$INDEX.new" && mv "$INDEX.new" "$INDEX"
  fi
fi

rm -f "$MOC/extract-progress.txt"
REPORT="$MOC/extract-report.tsv"
if [ -n "$PATHS" ] && [ -f "$REPORT" ]; then
  # a partial run keeps the report lines of every row it did not look at
  { cat "$REPORT_TMP"; awk -F'\t' 'NR==FNR { if (FNR>1) done_[$1]=1; next } FNR>1 && !($1 in done_)' "$REPORT_TMP" "$REPORT"; } > "$REPORT_TMP.merged" && mv "$REPORT_TMP.merged" "$REPORT_TMP"
fi
mv "$REPORT_TMP" "$REPORT"

echo "extract: processed=$processed  extracted=$extracted  keyword-only=$keyword_only  title-only(>${READ_CEILING}B)=$titled_only  offloaded-pulled=$downloaded  re-evicted=$evicted  skipped-fresh=$skipped_fresh  failed=$failed  no-text-layer=$no_text"
echo "extracts in: ${EXDIR/#$HOME/~}  ($(ls "$EXDIR" 2>/dev/null | wc -l | tr -d ' ') files)"
echo "keywords filled: $([ -s "$KWUP" ] && wc -l < "$KWUP" | tr -d ' ' || echo 0)  | next: bin/search.sh \"word inside a pdf\""
