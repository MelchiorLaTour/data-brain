#!/usr/bin/env bash
# capture.sh — drop an idea into the NewBrain inbox.
# Works with Claude OFF. The capture itself never needs Claude.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INBOX="$ROOT/INBOX.md"
TEXT="${*:-}"
if [ -z "$TEXT" ]; then
  echo "usage: capture.sh \"your idea\"" >&2
  exit 1
fi
TS="$(date '+%Y-%m-%d %H:%M')"
{
  echo ""
  echo "## $TS"
  echo ""
  echo "$TEXT"
  echo ""
  echo "status: unrouted"
  echo ""
  echo "---"
} >> "$INBOX"
echo "captured @ $TS -> $INBOX"
