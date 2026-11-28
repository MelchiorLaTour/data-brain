#!/usr/bin/env bash
# reach-map.sh — REPORT ONLY. Maps which indexed notes have their CONTENT on disk (full-text
# searchable) vs which are iCloud-OFFLOADED (dataless stubs — title/path is known, but search.sh
# cannot read their text). Pure metadata read (ls -lO / stat); never opens a file, never triggers
# an iCloud download, never deletes. Writes moc/REACH.md.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/moc/index.tsv"
OUT="$ROOT/moc/REACH.md"
TS="$(date '+%Y-%m-%d %H:%M')"
[ -s "$INDEX" ] || { echo "error: $INDEX missing" >&2; exit 1; }

tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT

# Classify every indexed path: local | offloaded | missing. Tally per room (first theme).
total=0; local_n=0; off_n=0; miss_n=0
while IFS=$'\t' read -r path title themes keywords; do
  case "$path" in \#*|"") continue ;; esac
  total=$((total+1))
  f="${path/#\~/$HOME}"
  room="${themes%%,*}"; [ -n "$room" ] || room="-"
  if [ ! -e "$f" ]; then
    state=missing; miss_n=$((miss_n+1))
  elif ls -lO "$f" 2>/dev/null | grep -q 'dataless'; then
    state=offloaded; off_n=$((off_n+1))
  else
    state=local; local_n=$((local_n+1))
  fi
  printf '%s\t%s\n' "$room" "$state" >> "$tmp"
done < "$INDEX"

# Per-room breakdown.
rooms="$(cut -f1 "$tmp" | sort -u)"
{
  echo "# NewBrain — Reach Map (what the brain can actually full-text search)"
  echo ""
  echo "_Generated $TS by bin/reach-map.sh. Metadata-only scan; no files opened, no downloads, no deletes._"
  echo ""
  echo "**A note is one of:**"
  echo "- **local** — content is on disk; \`search.sh\` reads its full text."
  echo "- **offloaded** — iCloud dataless stub; the title/path is indexed but full-text search CANNOT"
  echo "  reach its body until you download it (open it in Finder once, or right-click > Download Now)."
  echo "- **missing** — path no longer resolves (should be 0)."
  echo ""
  echo "## Headline"
  echo ""
  printf -- "- total indexed: **%s**\n" "$total"
  printf -- "- local (full-text searchable): **%s** (%s%%)\n" "$local_n" "$(( local_n*100/total ))"
  printf -- "- offloaded (title-only): **%s** (%s%%)\n" "$off_n" "$(( off_n*100/total ))"
  printf -- "- missing: **%s**\n" "$miss_n"
  echo ""
  echo "## By room"
  echo ""
  echo "| room | local | offloaded | missing | total |"
  echo "|------|------:|----------:|--------:|------:|"
  for r in $rooms; do
    l=$(awk -F'\t' -v R="$r" '$1==R && $2=="local"{n++} END{print n+0}' "$tmp")
    o=$(awk -F'\t' -v R="$r" '$1==R && $2=="offloaded"{n++} END{print n+0}' "$tmp")
    m=$(awk -F'\t' -v R="$r" '$1==R && $2=="missing"{n++} END{print n+0}' "$tmp")
    t=$((l+o+m))
    printf "| %s | %s | %s | %s | %s |\n" "$r" "$l" "$o" "$m" "$t"
  done | sort -t'|' -k5 -rn
} > "$OUT"

echo "wrote $OUT"
echo "total=$total  local=$local_n  offloaded=$off_n  missing=$miss_n"
