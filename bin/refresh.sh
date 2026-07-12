#!/usr/bin/env bash
# refresh.sh — ONE-COMMAND freshness pass (Step 3 of the search fix, 2026-07-05). Brings the
# brain's index up to date with whatever landed on the laptop since the last run:
#   ingest-root.sh over every CANON root  (append new files to index.tsv, dedup, no copies)
#   -> label-by-path.sh                   (label the new rows; never touches real labels)
#   -> extract.sh                         (plaintext sidecars for new pdf/docx/offloaded rows —
#                                          idempotent, skips everything already extracted; without
#                                          this a "preview.pdf"-titled lease stays unfindable)
#   -> rebuild.sh                         (redraw the human MOCs)
#   -> build-fts.sh                       (rebuild the ranked fts.db)
# plus one summary line appended to moc/log.md (the append-only ledger).
#
# Called three ways, zero owner-memory required:
#   nightly — launchd agent ~/Library/LaunchAgents/com.YOURNAME.newbrain.refresh.plist
#   hook    — wardrobe-discovery-hook.sh runs it in the background when fts.db is >26h old
#   manual  — "refresh the brain" in any session / `bash bin/refresh.sh` by hand
# Optional $1 tags the log line with which path fired (nightly|hook|manual).
#
# Claude-OFF: pure bash + the existing bin/ tools. NO COPIES, NEVER MOVE/RENAME — writes only
# NewBrain's own files (index.tsv, moc/ derived artifacts, log.md).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
INDEX="$ROOT/moc/index.tsv"
TAG="${1:-manual}"

# Single-flight lock: the nightly job, a hook-fired run, and a manual run must not interleave
# (two ingest loops appending to index.tsv at once = duplicate rows). mkdir is atomic; a lock
# older than 2h is a crash leftover and gets taken over so a stale lock can't kill freshness.
LOCK="$ROOT/moc/.refresh.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  age=$(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || echo 0) ))
  if [ "$age" -lt 7200 ]; then
    echo "refresh: another run holds the lock (${age}s old) — exiting" >&2
    exit 0
  fi
  rm -rf "$LOCK"; mkdir "$LOCK" || exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

before="$(( $(wc -l < "$INDEX") - 1 ))"
echo "== refresh ($TAG) $(date '+%Y-%m-%d %H:%M') — index $before notes =="

for root in "${CANON[@]}"; do
  [ -d "$root" ] || continue
  bash "$ROOT/bin/ingest-root.sh" "$root"
done

bash "$ROOT/bin/label-by-path.sh"
bash "$ROOT/bin/extract.sh"
bash "$ROOT/bin/rebuild.sh"
bash "$ROOT/bin/build-fts.sh"

after="$(( $(wc -l < "$INDEX") - 1 ))"
LOG="$ROOT/moc/log.md"
[ -f "$LOG" ] || printf '# NewBrain — change log (ingest history)\n\n_Append-only, newest at the bottom. `grep "^## \\[" moc/log.md | tail -5` for the latest._\n\n' > "$LOG"
printf '## [%s] refresh (%s) | index %s -> %s notes, fts rebuilt\n' \
  "$(date '+%Y-%m-%d %H:%M')" "$TAG" "$before" "$after" >> "$LOG"
echo "== refresh done: $before -> $after notes =="
