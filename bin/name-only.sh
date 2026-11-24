#!/bin/bash
# name-only.sh — which documents are indexed by NAME ONLY (their content is never downloaded, read or indexed).
# ChatGPT host only (the server sets NB_NAME_ONLY=1 for the engine scripts; nothing here runs otherwise). A binary document (pdf, docx, doc, pages, rtf) is
# name-only when:
#   - its name has "workbook" in it, or French "cahier d'exercices" (any case, any apostrophe or spacing), or
#   - Spotlight says it has more than 100 pages (mdls kMDItemNumberOfPages: known without downloading an online-only file), or
#   - Spotlight has no page count and the file is larger than 50 MB (50,000,000 bytes, as the Finder counts).
# A file with a page count of 100 or fewer, and a file with no page count under 50 MB, is read as usual (the page count is looked at again after the
# download, in extract.sh, which calls the same function). md and txt are plain text, read by the full-text index itself, and are not covered.
# Name-only paths are recorded in moc/name-only.tsv (canonical path TAB reason): cloud-scan.sh does not queue them, ingest-root.sh makes a row for them
# even while they are online-only, and extract.sh never reads them.
#   name-only.sh --paths LISTFILE     classify the absolute paths listed (one per line) and record the name-only ones
# Test hooks: NB_TEST_MDLS (a program that answers like mdls), NB_TEST_NAME_ONLY_BYTES (the size threshold).

nb_name_only_reason() {
  local f="$1" base norm pages size limit
  base="$(basename "$f")"
  norm=" $(printf '%s' "$base" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9]+/ /g') "
  case "$norm" in
    *workbook*) printf 'workbook'; return 0 ;;
    *" cahier d exercices "*|*" cahiers d exercices "*|*" cahier d exercice "*) printf 'workbook'; return 0 ;;
  esac
  pages="$("${NB_TEST_MDLS:-/usr/bin/mdls}" -raw -name kMDItemNumberOfPages "$f" 2>/dev/null)"
  case "$pages" in
    ''|*[!0-9]*) ;;
    *) if [ "$pages" -gt 100 ]; then printf 'more than 100 pages (%s)' "$pages"; return 0; fi; return 0 ;;   # a known page count decides
  esac
  limit="${NB_TEST_NAME_ONLY_BYTES:-50000000}"
  size="$(stat -f '%z' "$f" 2>/dev/null || echo 0)"
  if [ "$size" -gt "$limit" ]; then printf 'large file, page count unknown (over %s MB)' "$((limit / 1000000))"; return 0; fi
  return 0
}

# Records one path (canonical ~ form) with its reason, once.
nb_name_only_record() {
  local list="${NB_MOC_DIR:-}/name-only.tsv" canon="$1" reason="$2"
  [ -n "${NB_MOC_DIR:-}" ] || return 0
  if [ -f "$list" ] && /usr/bin/awk -F'\t' -v p="$canon" '$1 == p { found = 1 } END { exit !found }' "$list"; then return 0; fi
  printf '%s\t%s\n' "$canon" "$reason" >> "$list"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  export NB_MOC_DIR="${NB_MOC_DIR:-$ROOT/moc}"
  [ "${1:-}" = "--paths" ] && [ -f "${2:-}" ] || { echo "usage: name-only.sh --paths LISTFILE" >&2; exit 1; }
  mkdir -p "$NB_MOC_DIR"
  count=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$(printf '%s' "${f##*.}" | tr 'A-Z' 'a-z')" in pdf|docx|doc|pages|rtf) ;; *) continue ;; esac
    reason="$(nb_name_only_reason "$f")"
    [ -n "$reason" ] || continue
    nb_name_only_record "${f/#$HOME/~}" "$reason"
    count=$((count + 1))
  done < "$2"
  echo "name-only: $count document(s) indexed by name only"
fi
