#!/usr/bin/env bash
# prune-missing.sh — drop index.tsv rows whose file no longer exists. Rows only: never touches a file.
#
# ingest-root.sh only ever appends, so a file deleted from an approved folder would otherwise stay in
# the index (and in the freshness report as "deleted") forever. A row is dropped only when ALL hold:
#   - the row lies under a selected root that still exists as a directory (an unplugged volume or a
#     renamed root must not cost rows), and
#   - the file is gone (no entry at all; an iCloud-offloaded placeholder still counts as present), and
#   - its parent folder is either gone or searchable (an unreadable folder is not a deletion).
# Atomic rewrite, same file mode, one line appended to moc/log.md. Pure bash, no model, no network.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
MOC="${NB_MOC_DIR:-$ROOT/moc}"
INDEX="$MOC/index.tsv"
[ -f "$INDEX" ] && [ ! -L "$INDEX" ] || { echo "prune-missing: no regular index.tsv at $INDEX" >&2; exit 1; }
TMP="$(mktemp "$INDEX.prune.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

pruned=0
{
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) printf '%s\n' "$line"; continue ;;
    esac
    path="${line%%$'\t'*}"
    real="${path/#\~/$HOME}"
    drop=0
    if [ ! -e "$real" ] && [ ! -L "$real" ]; then
      parent="${real%/*}"
      if [ ! -e "$parent" ] || [ -x "$parent" ]; then
        for root in "${CANON[@]}"; do
          case "$real" in
            "$root"/*) [ -d "$root" ] && drop=1; break ;;
          esac
        done
      fi
    fi
    if [ "$drop" = 1 ]; then pruned=$((pruned + 1)); else printf '%s\n' "$line"; fi
  done < "$INDEX"
} > "$TMP"

if [ "$pruned" -gt 0 ]; then
  chmod "$(stat -f '%Lp' "$INDEX" 2>/dev/null || echo 600)" "$TMP"
  mv -f "$TMP" "$INDEX"
  printf '## [%s] prune-missing | %s row(s) removed (files gone)\n' "$(date '+%Y-%m-%d %H:%M')" "$pruned" >> "$MOC/log.md"
fi
echo "prune-missing: $pruned row(s) removed"
