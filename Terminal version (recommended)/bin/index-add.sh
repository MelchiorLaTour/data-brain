#!/usr/bin/env bash
# Register one existing, approved source file in the generated index. No copy or move.
# Usage: index-add.sh <absolute-file> [themes] [keywords]
# If keywords are omitted, tags: from the file frontmatter are retained.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
MOC="${NB_MOC_DIR:-$ROOT/moc}"
INDEX="$MOC/index.tsv"
F="${1:-}"; THEMES="${2:--}"; KEYWORDS="${3:-}"
[ -n "$F" ] && [ -f "$F" ] || { echo "usage: index-add.sh <existing-file> [themes] [keywords]" >&2; exit 1; }
case "$F" in /*) ;; *) echo 'index-add: path must be absolute' >&2; exit 1 ;; esac
is_approved_source_file "$F" || { echo 'index-add: file is outside approved folders, non-canonical, or a symbolic link' >&2; exit 1; }
case "$F" in *$'\n'*|*$'\r'*|*$'\t'*) echo 'index-add: file path contains a tab or line break' >&2; exit 1 ;; esac
[ -s "$INDEX" ] && [ ! -L "$INDEX" ] || { echo "error: $INDEX missing, empty, or a symbolic link" >&2; exit 1; }

# With the legacy two-argument call, take search keywords from note frontmatter.
if [ -z "$KEYWORDS" ]; then
  KEYWORDS="$(sed -n '2,/^---/p' "$F" | sed -n 's/^tags:[[:space:]]*\[\(.*\)\][[:space:]]*$/\1/p' | head -1)"
fi
clean_list() {
  printf '%s' "$1" | tr ',' '\n' | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//' | grep -v '^$' | paste -sd, - || true
}
THEMES="$(clean_list "$THEMES")"; KEYWORDS="$(clean_list "$KEYWORDS")"
for field in "$THEMES" "$KEYWORDS"; do
  case "$field" in *$'\n'*|*$'\r'*|*$'\t'*) echo 'index-add: themes and keywords cannot contain tabs or line breaks' >&2; exit 1 ;; esac
done
case "$F" in "$HOME"/*) CANON_PATH="~${F#"$HOME"}" ;; *) CANON_PATH="$F" ;; esac
base="${F##*/}"; ext="${base##*.}"
title="$(basename "$F" ".$ext" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2} //')"

# Serialize concurrent additions and replace the index atomically. Never follow a swapped
# index symlink, and leave the previous index intact if staging fails.
lock="$INDEX.lock"
if ! mkdir "$lock" 2>/dev/null; then
  # A lock left by a killed run, a crash or a reboot must not block every later write. It is stale when its owner is gone,
  # when it was made before the last boot (a reused PID cannot fool that), or when it is older than 10 minutes.
  owner="$(cat "$lock/pid" 2>/dev/null || true)"
  made="$(stat -f %m "$lock" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  boot="$(sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \([0-9]*\).*/\1/p')"
  stale=0
  if [ "$made" -lt "${boot:-0}" ] || [ $(( now - made )) -ge 600 ]; then stale=1
  elif [ -n "$owner" ]; then kill -0 "$owner" 2>/dev/null || stale=1
  elif [ $(( now - made )) -ge 10 ]; then stale=1; fi   # no PID yet: its maker is still starting, unless this is old
  if [ "$stale" -eq 1 ]; then rm -rf "$lock"; fi
  if [ "$stale" -ne 1 ] || ! mkdir "$lock" 2>/dev/null; then echo 'index-add: another index update is in progress' >&2; exit 1; fi
fi
printf '%s\n' "$$" > "$lock/pid" 2>/dev/null || true
tmp=''
cleanup() { [ -n "$tmp" ] && rm -f "$tmp" || true; rm -rf "$lock" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM
tmp="$(mktemp "$MOC/.index-add.XXXXXX")"
[ -f "$INDEX" ] && [ ! -L "$INDEX" ] || { echo 'index-add: index changed or became a symbolic link' >&2; exit 1; }

found=0
while IFS= read -r line || [ -n "${line:-}" ]; do
  path="${line%%$'\t'*}"
  if [ "$path" = "$CANON_PATH" ]; then
    IFS=$'\t' read -r _ old_title old_themes old_keywords extra <<< "$line"
    [ "$found" -eq 0 ] || { echo 'index-add: duplicate rows already exist for this file' >&2; exit 1; }
    printf '%s\t%s\t%s\t%s\n' "$path" "${old_title:-$title}" "${THEMES:--}" "${KEYWORDS:--}" >> "$tmp"
    found=1
  else
    printf '%s\n' "$line" >> "$tmp"
  fi
done < "$INDEX"
if [ "$found" -eq 0 ]; then
  printf '%s\t%s\t%s\t%s\n' "$CANON_PATH" "$title" "${THEMES:--}" "${KEYWORDS:--}" >> "$tmp"
fi
mv -f "$tmp" "$INDEX"
tmp=''
echo "indexed: $CANON_PATH  (themes=${THEMES:--}; keywords=${KEYWORDS:--})"
LOG="$MOC/log.md"
if [ ! -e "$LOG" ]; then
  (set -o noclobber; printf '# NewBrain — change log (ingest history)\n\n_Append-only, newest at the bottom._\n\n' > "$LOG") 2>/dev/null || true
fi
if [ -f "$LOG" ] && [ ! -L "$LOG" ]; then
  printf '## [%s] index-add | %s\n' "$(date '+%Y-%m-%d')" "$CANON_PATH" >> "$LOG"
fi
