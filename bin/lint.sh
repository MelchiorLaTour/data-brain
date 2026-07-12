#!/usr/bin/env bash
# lint.sh — REPORT-ONLY health check on moc/index.tsv. Catches index rot. Never deletes/moves/edits.
# Checks: (1) dead paths (file moved/deleted), (2) unlabeled rows (themes='-'), (3) duplicate titles.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/moc/index.tsv"
[ -s "$INDEX" ] || { echo "error: $INDEX missing/empty" >&2; exit 1; }
dead=0; unlabeled=0; total=0
echo "# NewBrain index lint — $(date '+%Y-%m-%d %H:%M')"; echo ""
echo "## Dead paths (indexed file no longer exists)"
while IFS=$'\t' read -r canon title themes kw; do
  [ -n "${canon:-}" ] || continue
  case "$canon" in \#*) continue ;; esac
  total=$((total+1))
  p="${canon/#\~/$HOME}"
  [ -e "$p" ] || { echo "- $canon"; dead=$((dead+1)); }
  [ "${themes:--}" = "-" ] && unlabeled=$((unlabeled+1))
done < "$INDEX"
[ "$dead" -eq 0 ] && echo "_none_"
echo ""; echo "## Duplicate titles (same title, multiple rows)"
dup="$(cut -f2 "$INDEX" | grep -v '^#' | sort | uniq -d)"
if [ -n "$dup" ]; then printf '%s\n' "$dup" | sed 's/^/- /'; else echo "_none_"; fi
echo ""; echo "## Stale wikis (compiled wiki older than its room's current index)"
stale="$("$ROOT/bin/stale-wikis.sh" 2>/dev/null)"
if [ -n "$stale" ]; then printf '%s\n' "$stale"; else echo "_none_"; fi
echo ""; echo "## Summary"
echo "- total rows: $total"
echo "- dead paths: $dead"
echo "- unlabeled rows (themes='-'): $unlabeled"
