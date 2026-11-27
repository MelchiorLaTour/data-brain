#!/usr/bin/env bash
# file-note.sh — file a captured idea into its canonical vault home WITH its room label
# baked in. "The move = the label": choosing the note's room IS filing it, in one step.
# No copies, no brain/ store — the note lives once, in the vault, and its `theme:` field
# is what places it in a room when bin/rebuild.sh redraws the map.
#
# Usage:
#   file-note.sh "<theme[,theme2]>" "<title>" [keywords]  # keywords default to themes
#   echo "body text" | file-note.sh "ideas" "Solar kite" "wind,energy"
#
# Themes: any existing room name (see moc/index.tsv) or a new one.
# A genuinely new room is fine — just name it; rebuild will create the room MOC.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
DEST="$VAULT/Ideas"          # the capture pile; theme (not folder) does the organizing

THEME="${1:-}"; TITLE="${2:-}"
if [ -z "$THEME" ] || [ -z "$TITLE" ]; then
  echo "usage: file-note.sh \"<theme[,theme2]>\" \"<title>\" [keywords]  (body on stdin)" >&2
  exit 1
fi
KEYWORDS="${3:-$THEME}"
case "$TITLE$THEME$KEYWORDS" in *$'\n'*|*$'\r'*|*$'\t'*) echo 'file-note: title, themes, and keywords cannot contain tabs or line breaks' >&2; exit 1 ;; esac
BODY="$(cat || true)"
DATE="$(date '+%Y-%m-%d')"
# Keep the human-readable title in the filename (vault convention: "YYYY-MM-DD Title.md"),
# stripping only characters illegal/awkward in a filename. Rooms display this title, so it
# must stay readable — do NOT slugify.
SAFE_TITLE="$(echo "$TITLE" | sed -E 's#[/:]# #g; s/  +/ /g; s/^ *//; s/ *$//')"
FILE="$DEST/$DATE $SAFE_TITLE.md"
# normalize theme list -> "[a, b]"
THEME_NORM="$(echo "$THEME" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$' | paste -sd ', ' -)"
KEYWORDS_NORM="$(printf '%s' "$KEYWORDS" | tr ',' '\n' | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//' | awk 'NF && !seen[$0]++' | paste -sd, - || true)"
[ -n "$KEYWORDS_NORM" ] || { echo 'file-note: provide 2–12 distinct search keywords' >&2; exit 1; }
IFS=',' read -ra keyword_list <<< "$KEYWORDS_NORM"
[ "${#keyword_list[@]}" -ge 2 ] && [ "${#keyword_list[@]}" -le 12 ] || {
  echo 'file-note: provide 2–12 distinct search keywords (third argument); at least two themes can serve as the default' >&2
  exit 1
}
for keyword in "${keyword_list[@]}"; do
  [[ "$keyword" =~ ^[a-z0-9][a-z0-9_-]{1,39}$ ]] || {
    echo "file-note: invalid search keyword '$keyword' (use 2–40 lowercase letters, digits, _ or -)" >&2
    exit 1
  }
done

if ! is_approved_directory_path "$DEST"; then
  echo "file-note: capture folder is not inside an approved source folder: $DEST" >&2
  exit 1
fi
if [ ! -d "$DEST" ]; then mkdir "$DEST" || { echo "file-note: could not create $DEST" >&2; exit 1; }; fi
is_approved_directory_path "$DEST" || { echo 'file-note: capture folder changed or is no longer approved' >&2; exit 1; }

# Exclusive creation ensures a same-day title collision never overwrites a real note.
umask 077
created=0
for ((n=0; n<100; n++)); do
  suffix=''; [ "$n" -eq 0 ] || suffix=" ($n)"
  candidate="$DEST/$DATE $SAFE_TITLE$suffix.md"
  if (set -o noclobber; : > "$candidate") 2>/dev/null; then FILE="$candidate"; created=1; break; fi
done
[ "$created" -eq 1 ] || { echo "file-note: no unused filename available for $TITLE" >&2; exit 1; }
if ! {
  echo "---"
  echo "type: idea"
  echo "source: inbox"
  echo "status: active"
  echo "created: $DATE"
  echo "theme: [$THEME_NORM]"
  echo "tags: [${KEYWORDS_NORM}]"
  echo "---"
  echo ""
  echo "# $TITLE"
  echo ""
  [ -n "$BODY" ] && echo "$BODY"
} >> "$FILE"; then
  echo "file-note: note was created but could not be written: $FILE" >&2
  exit 1
fi
echo "filed -> ${FILE/#$HOME/~}  (theme: [$THEME_NORM])"
if ! bash "$ROOT/bin/index-add.sh" "$FILE" "$THEME_NORM" "$KEYWORDS_NORM" ||
   ! bash "$ROOT/bin/rebuild.sh" ||
   ! bash "$ROOT/bin/build-fts.sh" ||
   ! bash "$ROOT/bin/inventory.sh"; then
  echo "file-note: note exists at $FILE, but indexing did not finish; rerun bin/refresh.sh" >&2
  exit 1
fi
echo 'indexed, searchable, and recorded in inventory'
