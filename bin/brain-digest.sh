#!/usr/bin/env bash
# brain-digest.sh — Graft 3 (the GATE): SessionStart priming digest.
# Prints a BOUNDED map of the brain (rooms + counts + a few recent titles + the
# access line) so every fresh session KNOWS the brain exists and roughly what's in it,
# and consults it at the right time instead of gambling on the keyword-hook firing.
# Pure bash, works cold, no model/network. Instant reads only (no per-file stat pass —
# recent.sh's mtime sort costs ~6s and surfaces machinery, so it is NOT used here).
# Registered as a SessionStart hook (matcher startup|clear|compact) in ~/.claude/settings.json.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/moc/index.tsv"
LOG="$ROOT/moc/log.md"
[ -s "$INDEX" ] || exit 0   # no brain, nothing to prime — stay silent

# Rooms + counts (multi-label: a note lists in every room its themes name). Instant awk, no stat.
# awk emits "count<TAB>name", sort by count desc, then format as "name·count".
rooms=$(awk -F'\t' 'NR>1 && $1!~/^#/{n=split($3,a,","); for(i=1;i<=n;i++){gsub(/^ +| +$/,"",a[i]); if(a[i]!="")c[a[i]]++}} END{for(k in c)printf "%d\t%s\n",c[k],k}' "$INDEX" | sort -rn)
nrooms=$(printf '%s\n' "$rooms" | grep -c .)
nnotes=$(( $(grep -c . "$INDEX") - 1 ))
roomline=$(printf '%s\n' "$rooms" | awk -F'\t' 'NF{printf "%s·%s ",$2,$1}')

# A few most-recently-INDEXED note titles (tail = append order ≈ ingest recency). Instant.
recent=$(tail -5 "$INDEX" | cut -f2 | sed 's/^/  · /')

# Freshness: last ingest event (tail of the append-only ledger). Instant.
lastlog=$(grep '^## ' "$LOG" 2>/dev/null | tail -1 | sed 's/^## //')

# Anti-rot: any compiled room wiki whose room drifted since it was built. Silent when fresh.
stale=$("$ROOT/bin/stale-wikis.sh" 2>/dev/null)

{
  printf '🧠 NEWBRAIN — the owner'\''s second brain is LIVE (%s notes across %s rooms). Query it BEFORE answering any question about the owner'\''s own notes, knowledge, ideas, people, or life.\n' "$nnotes" "$nrooms"
  printf 'ACCESS: `bash %s/bin/abstain-check.sh "<query>"` then read routed hits via `look.sh` and judge — answer, or honestly say "not in the brain". (fallback: `fts.sh "<keywords>"`.)\n' "${ROOT/#$HOME/~}"
  printf 'ROOMS (name·count): %s\n' "$roomline"
  [ -n "$recent" ] && printf 'Recently indexed:\n%s\n' "$recent"
  [ -n "$lastlog" ] && printf 'Last update: %s\n' "$lastlog"
  [ -n "$stale" ] && printf '%s\n' "$stale"
} | jq -Rs '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:.}}'
exit 0
