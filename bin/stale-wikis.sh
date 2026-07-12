#!/usr/bin/env bash
# stale-wikis.sh — REPORT-ONLY anti-rot guard. For every compiled room wiki
# (moc/wiki/<room>/_BUNDLE.md carrying a `newbrain-stamp` header), recompute the room's
# CURRENT signature and print one line if it drifted from the stamp written at compile time.
# Prints NOTHING when all compiled wikis are fresh (or none are compiled) — silent = clean.
# Shared by lint.sh and brain-digest.sh so rot surfaces identically in both places.
# Pure bash, Claude-OFF, reads only NewBrain's own files. Never edits/deletes/moves anything.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIKI="$ROOT/moc/wiki"
[ -d "$WIKI" ] || exit 0

for b in "$WIKI"/*/_BUNDLE.md; do
  [ -f "$b" ] || continue
  line="$(grep -m1 '<!-- newbrain-stamp ' "$b" 2>/dev/null)" || continue
  [ -n "$line" ] || continue
  room="$(printf '%s\n' "$line" | sed -n 's/.*room=\([^ ]*\).*/\1/p')"
  ocount="$(printf '%s\n' "$line" | sed -n 's/.*count=\([^ ]*\).*/\1/p')"
  ohash="$(printf '%s\n' "$line" | sed -n 's/.*hash=\([^ ]*\).*/\1/p')"
  odate="$(printf '%s\n' "$line" | sed -n 's/.*date=\([^ ]*\).*/\1/p')"
  [ -n "$room" ] && [ -n "$ohash" ] || continue
  cur="$("$ROOT/bin/room-stamp.sh" "$room")" || continue
  ccount="${cur%%$'\t'*}"; chash="${cur##*$'\t'}"
  if [ "$chash" != "$ohash" ]; then
    printf '⚠ wiki stale: %s (%s notes @ compile %s → %s now; run `compile-room.sh %s` + re-synthesize)\n' \
      "$room" "$ocount" "$odate" "$ccount" "$room"
  fi
done
exit 0
