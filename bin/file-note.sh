#!/usr/bin/env bash
# file-note.sh — file a captured idea into its canonical vault home WITH its room label
# baked in. "The move = the label": choosing the note's room IS filing it, in one step.
# No copies, no brain/ store — the note lives once, in the vault, and its `theme:` field
# is what places it in a room when bin/rebuild.sh redraws the map.
#
# Usage:
#   file-note.sh "<theme[,theme2]>" "<title>"            # body read from stdin
#   echo "body text" | file-note.sh "ideas" "Solar kite"
#
# Themes: any existing room name (see moc/index.tsv) or a new one.
# A genuinely new room is fine — just name it; rebuild will create the room MOC.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
DEST="$VAULT/Ideas"          # the capture pile; theme (not folder) does the organizing

THEME="${1:-}"; TITLE="${2:-}"
if [ -z "$THEME" ] || [ -z "$TITLE" ]; then
  echo "usage: file-note.sh \"<theme[,theme2]>\" \"<title>\"  (body on stdin)" >&2
  exit 1
fi
BODY="$(cat || true)"
DATE="$(date '+%Y-%m-%d')"
# Keep the human-readable title in the filename (vault convention: "YYYY-MM-DD Title.md"),
# stripping only characters illegal/awkward in a filename. Rooms display this title, so it
# must stay readable — do NOT slugify.
SAFE_TITLE="$(echo "$TITLE" | sed -E 's#[/:]# #g; s/  +/ /g; s/^ *//; s/ *$//')"
FILE="$DEST/$DATE $SAFE_TITLE.md"
# normalize theme list -> "[a, b]"
THEME_NORM="$(echo "$THEME" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$' | paste -sd ', ' -)"

mkdir -p "$DEST"
{
  echo "---"
  echo "type: idea"
  echo "source: inbox"
  echo "status: active"
  echo "created: $DATE"
  echo "theme: [$THEME_NORM]"
  echo "---"
  echo ""
  echo "# $TITLE"
  echo ""
  [ -n "$BODY" ] && echo "$BODY"
} > "$FILE"
echo "filed -> ${FILE/#$HOME/~}  (theme: [$THEME_NORM])"
echo "run bin/rebuild.sh to redraw the rooms"
