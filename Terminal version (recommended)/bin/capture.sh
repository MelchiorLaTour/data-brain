#!/usr/bin/env bash
# Create one raw, searchable capture inside a user-approved source folder.
# Usage: capture.sh "Title" "keyword1,keyword2" [approved-destination] (body on stdin)
# Pass "-" for keywords to choose them in an interactive prompt.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"

TITLE="${1:-}"
KEYWORDS="${2:-}"
DEST="${3:-$VAULT}"
[ -n "$TITLE" ] || { echo 'usage: capture.sh "Title" "keyword1,keyword2" [approved-destination] (body on stdin)' >&2; exit 1; }
case "$TITLE$KEYWORDS$DEST" in *$'\n'*|*$'\r'*|*$'\t'*) echo 'capture: title, keywords, and destination cannot contain tabs or line breaks' >&2; exit 1 ;; esac

body="$(cat)"
[ -n "${body//[[:space:]]/}" ] || { echo 'capture: provide note content on stdin' >&2; exit 1; }
if [ "$KEYWORDS" = "-" ] || [ -z "$KEYWORDS" ]; then
  if [ ! -t 0 ] && [ ! -t 1 ] && [ ! -t 2 ]; then
    echo 'capture: provide 2–12 keywords, or run interactively to choose them' >&2
    exit 1
  fi
  if ! printf 'Search keywords (2–12, comma-separated): ' >/dev/tty ||
     ! IFS= read -r KEYWORDS </dev/tty; then
    echo 'capture: keyword selection was cancelled' >&2
    exit 1
  fi
fi

SAFE_TITLE="$(printf '%s' "$TITLE" | tr '/:' '  ' | tr -d '[:cntrl:]' | sed -E 's/[[:space:]]+/ /g;s/^ //;s/ $//' | cut -c1-120)"
[ -n "$SAFE_TITLE" ] && [ "$SAFE_TITLE" != . ] && [ "$SAFE_TITLE" != .. ] || { echo 'capture: title cannot be used as a filename' >&2; exit 1; }
KEYWORDS_NORM="$(printf '%s' "$KEYWORDS" | tr ',' '\n' | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//' | awk 'NF && !seen[$0]++' | paste -sd, - || true)"
[ -n "$KEYWORDS_NORM" ] || { echo 'capture: provide 2–12 distinct search keywords' >&2; exit 1; }
IFS=',' read -ra keyword_list <<< "$KEYWORDS_NORM"
[ "${#keyword_list[@]}" -ge 2 ] && [ "${#keyword_list[@]}" -le 12 ] || {
  echo 'capture: provide 2–12 distinct search keywords' >&2; exit 1;
}
for keyword in "${keyword_list[@]}"; do
  [[ "$keyword" =~ ^[a-z0-9][a-z0-9_-]{1,39}$ ]] || {
    echo "capture: invalid search keyword '$keyword' (use 2–40 lowercase letters, digits, _ or -)" >&2
    exit 1
  }
done

is_approved_directory_path "$DEST" || { echo 'capture: destination must be inside an already approved source folder' >&2; exit 1; }
[ -d "$DEST" ] || { echo 'capture: destination folder does not exist; choose an existing approved folder' >&2; exit 1; }
is_approved_directory_path "$DEST" || { echo 'capture: destination changed or is no longer approved' >&2; exit 1; }
DATE="$(date '+%Y-%m-%d')"
umask 077
created=0
for ((n=0; n<100; n++)); do
  suffix=''; [ "$n" -eq 0 ] || suffix=" ($n)"
  candidate="$DEST/$DATE $SAFE_TITLE$suffix.md"
  if (set -o noclobber; : > "$candidate") 2>/dev/null; then FILE="$candidate"; created=1; break; fi
done
[ "$created" -eq 1 ] || { echo "capture: no unused filename available for $TITLE" >&2; exit 1; }

if ! {
  printf '%s\n' '---' 'type: idea' 'source: inbox' 'status: unrouted' "created: $DATE" 'theme: []' "tags: [$KEYWORDS_NORM]" '---' '' "# $TITLE" '' "$body"
} >> "$FILE"; then
  echo "capture: new note was created but could not be written: $FILE" >&2
  exit 1
fi

if ! bash "$ROOT/bin/index-add.sh" "$FILE" '-' "$KEYWORDS_NORM" ||
   ! bash "$ROOT/bin/rebuild.sh" >/dev/null ||
   ! bash "$ROOT/bin/build-fts.sh" ||
   ! bash "$ROOT/bin/inventory.sh"; then
  echo "capture: note exists at $FILE, but indexing did not finish; rerun bin/refresh.sh" >&2
  exit 1
fi
echo "captured and indexed -> ${FILE/#$HOME/~} (keywords: $KEYWORDS_NORM)"
