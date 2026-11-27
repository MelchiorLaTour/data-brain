#!/usr/bin/env bash
# inbox-status.sh — the backlog nudge. Prints unrouted count + oldest-item age.
# Works with Claude OFF. So a capture backlog can never quietly rot.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INBOX="$ROOT/INBOX.md"
[ -f "$INBOX" ] || { echo "no inbox yet"; exit 0; }
UNROUTED="$(grep -c '^status: unrouted' "$INBOX" || true)"
if [ "$UNROUTED" -eq 0 ]; then
  echo "inbox clear — 0 unrouted."
  exit 0
fi
# oldest unrouted entry = first '## <date>' heading whose block is still unrouted.
# Heuristic: the first dated heading in the file that precedes an unrouted status.
OLDEST="$(awk '
  /^## [0-9]{4}-[0-9]{2}-[0-9]{2}/ { h=$0 }
  /^status: unrouted/ && h!="" { sub(/^## /,"",h); print h; exit }
' "$INBOX")"
echo "inbox: $UNROUTED unrouted. oldest: ${OLDEST:-unknown}"
echo "-> run a routing pass (see ROUTING.md) when convenient."
