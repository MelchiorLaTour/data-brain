#!/usr/bin/env bash
# recent.sh — show the N most-recently-MODIFIED indexed notes (P3 Option A, freshness signal).
# Stats canonical paths from moc/index.tsv by mtime; no schema change, stores nothing. Claude-OFF safe.
# Usage:  bin/recent.sh [N]   (default 20)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/moc/index.tsv"
N="${1:-20}"
[ -s "$INDEX" ] || { echo "error: $INDEX missing/empty" >&2; exit 1; }
while IFS=$'\t' read -r canon title themes kw; do
  [ -n "${canon:-}" ] || continue
  case "$canon" in \#*) continue ;; esac
  p="${canon/#\~/$HOME}"
  m="$(stat -f '%m' "$p" 2>/dev/null)" || continue
  [ -n "$m" ] && printf '%s\t%s\t%s\n' "$m" "$title" "$canon"
done < "$INDEX" | sort -rn | head -n "$N" | while IFS=$'\t' read -r m title canon; do
  printf '%s  %s  (%s)\n' "$(date -r "$m" '+%Y-%m-%d')" "$title" "$canon"
done
