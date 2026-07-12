#!/usr/bin/env bash
# index-add.sh — file ONE new real file back into moc/index.tsv (single-file ingest-root.sh).
# Use when a session saves a genuine new artifact and you want it findable. NO COPY: points at the
# real file in place; never moves/renames it. Claude-OFF safe.
# Usage:  bin/index-add.sh /absolute/path/to/file [theme1,theme2]   (themes optional)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/moc/index.tsv"
F="${1:-}"; THEMES="${2:--}"
[ -n "$F" ] && [ -f "$F" ] || { echo "usage: index-add.sh <existing-file> [themes]" >&2; exit 1; }
[ -s "$INDEX" ] || { echo "error: $INDEX missing/empty" >&2; exit 1; }
abs="$(cd "$(dirname "$F")" && pwd)/$(basename "$F")"
canon="${abs/#$HOME/~}"
if cut -f1 "$INDEX" | sed "s#^~#$HOME#" | grep -qxF "$abs"; then
  echo "already indexed: $canon"; exit 0
fi
base="$(basename "$F")"; ext="${base##*.}"
title="$(basename "$F" ".$ext" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2} //')"
printf '%s\t%s\t%s\t%s\n' "$canon" "$title" "${THEMES:--}" "-" >> "$INDEX"
echo "indexed: $canon  (themes=${THEMES:--})"
LOG="$ROOT/moc/log.md"
[ -f "$LOG" ] || printf '# NewBrain — change log (ingest history)\n\n_Append-only, newest at the bottom._\n\n' > "$LOG"
printf '## [%s] index-add | %s\n' "$(date '+%Y-%m-%d')" "$canon" >> "$LOG"
echo "next: bash bin/rebuild.sh"
