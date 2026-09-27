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
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
MOC="${NB_MOC_DIR:-$ROOT/moc}"
INDEX="$MOC/index.tsv"
EXDIR="$MOC/extracted"
[ -s "$INDEX" ] || { echo "error: $INDEX missing/empty" >&2; exit 1; }
mkdir -p "$EXDIR"

ROOM=""; LIMIT=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --room)  ROOM="${2:-}"; shift 2 ;;
    --limit) LIMIT="${2:-0}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "usage: extract.sh [--room NAME] [--limit N] [--force]" >&2; exit 1 ;;
  esac
done

# Reference-material size cap (corpus-hygiene decision, 2026-07-05): a body larger than CAP is a
# textbook/manual, not a personal note, and its multi-MB text drowns real notes in ranked search.
# Above CAP -> index TITLE + KEYWORDS only (keywords still derived; NO extract body written).
# Generic by size, so any future giant PDF is handled with no hardcoded path list. Measured cliff:
# the 17 known textbooks are all >1.05MB; the largest real note extract is ~471KB -> 800KB is safe.
CAP=800000

tmpd="$(mktemp -d)"
out_tmp=""
cleanup() { [ -z "$out_tmp" ] || rm -f -- "$out_tmp"; rm -rf "$tmpd"; }
trap cleanup EXIT
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
      if command -v pdftotext >/dev/null 2>&1; then
        t="$(pdftotext -q "$f" - 2>/dev/null)"
      elif [ -x /usr/bin/osascript ] && [ -f "$ROOT/setup/mcp/pdf-extract.js" ]; then
        t="$(/usr/bin/osascript -l JavaScript "$ROOT/setup/mcp/pdf-extract.js" "$f" 2>/dev/null)"
      fi
      ;;
    docx|doc|rtf)    t="$(textutil -convert txt -stdout "$f" 2>/dev/null)"
                     [ -n "$t" ] || t="$(pandoc -t plain "$f" 2>/dev/null)" ;;
    pages)           t="$(textutil -convert txt -stdout "$f" 2>/dev/null)"
                     [ -n "$t" ] || t="$(pandoc -t plain "$f" 2>/dev/null)" ;;
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

is_offloaded() { ls -lO "$1" 2>/dev/null | grep -q 'dataless'; }

processed=0; extracted=0; keyword_only=0; skipped_fresh=0; failed=0; downloaded=0; evicted=0; titled_only=0
while IFS=$'\t' read -r path title themes keywords; do
  case "$path" in \#*|"") continue ;; esac
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

  hash="$(printf '%s' "$path" | shasum | cut -c1-16)"
  out="$EXDIR/$hash.txt"
  # stat uses lstat semantics here. Once the file is opened below, comparing its
  # inode with /dev/fd/9 rejects a symlink swap between this check and open.
  fingerprint="$(stat -f '%i:%z:%m:%c' "$f" 2>/dev/null || true)"
  if [ -z "$fingerprint" ]; then failed=$((failed+1)); printf '%s\tstat_failed\n' "$path" >> "$REPORT_TMP"; continue; fi
  if [ "$select_keywords_only" -eq 0 ] && [ "$FORCE" -eq 0 ] && [ -s "$out" ] \
      && [ "$(sed -n '1p' "$out")" = "<!-- newbrain-extract source: $path -->" ] \
      && [ "$(sed -n '2p' "$out")" = "<!-- newbrain-extract fingerprint: $fingerprint -->" ]; then
    skipped_fresh=$((skipped_fresh+1)); printf '%s\tcached\n' "$path" >> "$REPORT_TMP"; continue
  fi
  [ "$LIMIT" -gt 0 ] && [ "$processed" -ge "$LIMIT" ] && break
  processed=$((processed+1))

  was_off=0; if is_offloaded "$f"; then was_off=1; downloaded=$((downloaded+1)); fi
  if ! exec 9<"$f"; then
    failed=$((failed+1)); printf '%s\topen_failed\n' "$path" >> "$REPORT_TMP"; continue
  fi
  opened_fingerprint="$(stat -f '%i:%z:%m:%c' /dev/fd/9 2>/dev/null || true)"
  if [ "$opened_fingerprint" != "$fingerprint" ]; then
    exec 9<&-
    failed=$((failed+1)); printf '%s\tsource_changed_before_open\n' "$path" >> "$REPORT_TMP"; continue
  fi
  staged_source="$tmpd/source.$ext"
  if ! cat /dev/fd/9 > "$staged_source"; then
    exec 9<&-
    failed=$((failed+1)); printf '%s\tread_failed\n' "$path" >> "$REPORT_TMP"; continue
  fi
  after_copy_fd="$(stat -f '%i:%z:%m:%c' /dev/fd/9 2>/dev/null || true)"
  after_copy_path="$(stat -f '%i:%z:%m:%c' "$f" 2>/dev/null || true)"
  exec 9<&-
  if [ "$after_copy_fd" != "$opened_fingerprint" ] || [ "$after_copy_path" != "$opened_fingerprint" ]; then
    failed=$((failed+1)); printf '%s\tsource_changed_during_copy\n' "$path" >> "$REPORT_TMP"; continue
  fi
  text="$(extract_text "$staged_source" "$ext")"
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
    failed=$((failed+1)); rm -f "$out"; printf '%s\textraction_failed\n' "$path" >> "$REPORT_TMP"; continue
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

  # size cap: textbook/manual bodies are title-only (keep keywords, drop the drowning body).
  if [ "${#text}" -gt "$CAP" ]; then
    rm -f "$out"
    if [ "$keywords" = "-" ] || [ -z "$keywords" ]; then
      kw="$(derive_keywords "$text")"
      [ -n "$kw" ] && printf '%s\t%s\n' "$path" "$kw" >> "$KWUP"
    fi
    titled_only=$((titled_only+1))
    printf '%s\ttitle_and_keywords_only\n' "$path" >> "$REPORT_TMP"
    continue
  fi

  # write the derived extract with a source header so a search hit traces back to the real file
  out_tmp="$(mktemp "${out}.tmp.XXXXXX")"
  { printf '<!-- newbrain-extract source: %s -->\n' "$path"; printf '<!-- newbrain-extract fingerprint: %s -->\n\n' "$fingerprint"; printf '%s\n' "$text"; } > "$out_tmp"
  mv -f -- "$out_tmp" "$out"
  out_tmp=""
  extracted=$((extracted+1))
  printf '%s\textracted\n' "$path" >> "$REPORT_TMP"

  # queue a keyword fill (applied in one awk pass below) only if the row has none yet
  if [ "$keywords" = "-" ] || [ -z "$keywords" ]; then
    kw="$(derive_keywords "$text")"
    [ -n "$kw" ] && printf '%s\t%s\n' "$path" "$kw" >> "$KWUP"
  fi
done < "$INDEX"

REPORT="$MOC/extract-report.tsv"
mv "$REPORT_TMP" "$REPORT"

# Single pass: fill keywords col (col4) for queued paths whose current value is still '-'.
if [ -s "$KWUP" ]; then
  awk -F'\t' -v OFS='\t' '
    NR==FNR { upd[$1]=$2; next }
    /^#/    { print; next }
    { if (($1 in upd) && ($4=="-" || $4=="")) $4=upd[$1]; print }
  ' "$KWUP" "$INDEX" > "$INDEX.new" && mv "$INDEX.new" "$INDEX"
fi

echo "extract: processed=$processed  extracted=$extracted  keyword-only=$keyword_only  title-only(>${CAP}B)=$titled_only  offloaded-pulled=$downloaded  re-evicted=$evicted  skipped-fresh=$skipped_fresh  failed=$failed"
echo "extracts in: ${EXDIR/#$HOME/~}  ($(ls "$EXDIR" 2>/dev/null | wc -l | tr -d ' ') files)"
echo "keywords filled: $([ -s "$KWUP" ] && wc -l < "$KWUP" | tr -d ' ' || echo 0)  | next: bin/search.sh \"word inside a pdf\""
