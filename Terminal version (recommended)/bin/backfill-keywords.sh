#!/usr/bin/env bash
# backfill-keywords.sh — Step 4 of the search fix (2026-07-05). Two passes over moc/index.tsv:
#   A. STRIP bare-year tokens (1900-2099) from every keywords list (col 4) — year tokens collide
#      across resumes/tax docs/coursework and poison year queries. A list left empty becomes '-'.
#   B. BACKFILL rows whose keywords are still '-' from content that is ALREADY on disk:
#      the note's extract (moc/extracted/<hash>.txt) if one exists, else the local md/txt body.
#      Same top-terms algorithm as extract.sh (stopwords, 4-20 chars, no bare years, max 8).
#      Never clobbers a non-'-' keywords value. No downloads, no file moves, index.tsv only.
# Claude-OFF (pure bash/awk), idempotent, re-runnable. Backup is the CALLER's job
# (cp moc/index.tsv moc/index.tsv.<tag>.bak) per the Step 4 gate rules.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/moc/index.tsv"
EXDIR="$ROOT/moc/extracted"
[ -s "$INDEX" ] || { echo "error: $INDEX missing/empty" >&2; exit 1; }

tmpd="$(mktemp -d)"; trap 'rm -rf "$tmpd"' EXIT
STOP="$tmpd/stop"; KWUP="$tmpd/kwupdates"; : > "$KWUP"
# Same stopword list as extract.sh (keep in sync).
# EDIT: replace the two placeholder tokens with your own first/last name (lowercase).
printf '%s\n' \
  this that with from have were your you our their them they will would there here what when which \
  into over under about above been being also only just more most some such than then these those \
  page pages http https www com docx file files note notes yourfirstname yourlastname \
  pour avec dans les des une sur est sont être cette mais plus tout nous vous leur \
  > "$STOP"

derive_keywords() {
  printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '\n' \
    | awk 'length($0)>=4 && length($0)<=20 && $0 !~ /^(19|20)[0-9][0-9]$/' \
    | grep -vwF -f "$STOP" \
    | sort | uniq -c | sort -rn | awk 'NR<=8{print $2}' | paste -sd, -
}

# ---- Pass A: strip bare-year tokens from every keywords list ----
stripped=$(awk -F'\t' 'NR>1 && !/^#/ {n=split($4,k,","); for(i=1;i<=n;i++) if (k[i] ~ /^(19|20)[0-9][0-9]$/) {c++; next}} END{print c+0}' "$INDEX")
awk -F'\t' -v OFS='\t' '
  /^#/ { print; next }
  {
    n=split($4,k,","); out=""
    for(i=1;i<=n;i++) if (k[i] !~ /^(19|20)[0-9][0-9]$/ && k[i] != "") out = out (out=="" ? "" : ",") k[i]
    $4 = (out=="" ? "-" : out)
    print
  }
' "$INDEX" > "$INDEX.new" && mv "$INDEX.new" "$INDEX"
echo "pass A: bare-year tokens stripped from $stripped rows"

# ---- Pass B: backfill '-' rows from existing extracts / local md-txt bodies ----
filled=0; nobody=0
while IFS=$'\t' read -r path title themes keywords; do
  case "$path" in \#*|"") continue ;; esac
  case "$path" in *Resources/Sensitive/*) continue ;; esac
  [ "$keywords" = "-" ] || [ -z "$keywords" ] || continue
  f="${path/#\~/$HOME}"
  hash="$(printf '%s' "$path" | shasum | cut -c1-16)"
  text=""
  if [ -s "$EXDIR/$hash.txt" ]; then
    text="$(sed '1{/^<!-- newbrain-extract source:/d;}' "$EXDIR/$hash.txt")"
  else
    ext="$(printf '%s' "${f##*.}" | tr 'A-Z' 'a-z')"
    case "$ext" in
      md|markdown|txt)
        # local body only — never trigger an iCloud download for a keyword pass
        if [ -e "$f" ] && ! ls -lO "$f" 2>/dev/null | grep -q 'dataless'; then
          text="$(cat "$f" 2>/dev/null)"
        fi ;;
    esac
  fi
  if [ -z "$text" ]; then nobody=$((nobody+1)); continue; fi
  kw="$(derive_keywords "$text")"
  [ -n "$kw" ] && { printf '%s\t%s\n' "$path" "$kw" >> "$KWUP"; filled=$((filled+1)); }
done < "$INDEX"

if [ -s "$KWUP" ]; then
  awk -F'\t' -v OFS='\t' '
    NR==FNR { upd[$1]=$2; next }
    /^#/    { print; next }
    { if (($1 in upd) && ($4=="-" || $4=="")) $4=upd[$1]; print }
  ' "$KWUP" "$INDEX" > "$INDEX.new" && mv "$INDEX.new" "$INDEX"
fi
remaining=$(awk -F'\t' 'NR>1 && !/^#/ && ($4=="-" || $4=="") {c++} END{print c+0}' "$INDEX")
echo "pass B: filled=$filled  no-local-body=$nobody  still-empty=$remaining"
echo "next: bin/rebuild.sh && bin/build-fts.sh && bin/lint.sh"
