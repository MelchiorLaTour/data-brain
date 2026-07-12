#!/usr/bin/env bash
# room-stamp.sh — emit a room's staleness SIGNATURE: "<count>\t<hash>".
# hash = shasum (first 16 hex) of the room's sorted "path<TAB>title" index rows.
# Shared by compile-room.sh (which writes the stamp into a wiki's _BUNDLE.md header)
# and stale-wikis.sh (which re-reads it), so the write side and the check side compute
# the signature the SAME way and can never disagree — same "single shared source" idea
# as canon.sh. Pure bash, Claude-OFF, reads nothing but the index.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="${NB_INDEX:-$ROOT/moc/index.tsv}"
room="${1:?usage: room-stamp.sh <room>}"
[ -s "$INDEX" ] || { echo "error: $INDEX missing/empty" >&2; exit 1; }

# a note is in the room if <room> is one of its comma-split themes (multi-label).
rows="$(awk -F'\t' -v r="$room" '
  $1 !~ /^#/ { n=split($3,a,","); for(i=1;i<=n;i++){ g=a[i]; gsub(/^ +| +$/,"",g); if(g==r){ print $1"\t"$2; break } } }
' "$INDEX" | LC_ALL=C sort)"

count="$(printf '%s' "$rows" | grep -c .)"
hash="$(printf '%s' "$rows" | shasum | cut -c1-16)"
printf '%s\t%s\n' "$count" "$hash"
