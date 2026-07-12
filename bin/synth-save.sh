#!/usr/bin/env bash
# synth-save.sh — wire a Claude-produced SYNTHESIS back into the brain as a new note, so derived
# knowledge accumulates ("the brain compounds" — corpus-hygiene decision 4, 2026-07-05).
#
# THE CONVENTION (Claude-side, see sectors/brain.md): when Claude produces a synthesis in a brain
# context, it (1) shows the synthesis, (2) asks ONE inline "wire this into the brain? [keep/drop]",
# and (3) ONLY on "keep" runs this script. Nothing is ever wired in without that yes (a wrong
# synthesis would poison future retrievals). Raw/ambiguous captures still go to INBOX.md via capture.sh.
#
# A synthesis is NEW authored content, so it gets a REAL home (SYNTH_DEST, default
# ~/brain-syntheses/) and then index-add.sh points at it in place — consistent with no-copy
# (the home IS its canonical location). The destination MUST sit under one of canon.sh's CANON
# roots so it stays searchable. Pure bash / Claude-OFF safe; body read from stdin.
#
# Usage:  bin/synth-save.sh "Human Title" "theme1,theme2"  <<'EOF'
#         ...synthesis markdown body...
#         EOF
#   env SYNTH_SKIP_FTS=1  skips the fts.db rebuild (batch several saves, then run build-fts.sh once).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# EDIT (or set SYNTH_DEST): must sit under a canon.sh CANON root so it stays searchable.
DEST_DIR="${SYNTH_DEST:-$HOME/brain-syntheses}"
TITLE="${1:-}"; THEMES="${2:--}"
[ -n "$TITLE" ] || { echo "usage: synth-save.sh \"Title\" [themes]   (body on stdin)" >&2; exit 1; }

body="$(cat)"
[ -n "$body" ] || { echo "synth-save: empty body on stdin — nothing saved" >&2; exit 1; }

mkdir -p "$DEST_DIR"
d="$(date '+%Y-%m-%d')"
# keep the human title in the filename; strip only filesystem-hostile chars
slug="$(printf '%s' "$TITLE" | tr '/' '-' | tr ':' '-' | tr -d '[:cntrl:]')"
dest="$DEST_DIR/$d $slug.md"
if [ -e "$dest" ]; then dest="$DEST_DIR/$d $slug ($(date '+%H%M%S')).md"; fi

{
  printf -- '---\n'
  printf 'type: synthesis\n'
  printf 'source: claude-synthesis\n'
  printf 'created: %s\n' "$d"
  printf 'themes: [%s]\n' "$THEMES"
  printf -- '---\n\n'
  printf '# %s\n\n' "$TITLE"
  printf '%s\n' "$body"
} > "$dest"
echo "saved synthesis -> ${dest/#$HOME/~}"

# wire it in: register the row (no copy), refresh the human MOCs
bash "$ROOT/bin/index-add.sh" "$dest" "$THEMES"
bash "$ROOT/bin/rebuild.sh" >/dev/null 2>&1 && echo "rebuilt MOCs"

# make it findable by the PRIMARY ranked search (fts.sh). search.sh (live full-text) already
# reaches it with no rebuild; fts.db needs a rebuild to include it.
if [ "${SYNTH_SKIP_FTS:-0}" = "1" ]; then
  echo "fts.db NOT rebuilt (SYNTH_SKIP_FTS=1) — run: bash bin/build-fts.sh when done batching"
else
  echo "rebuilding fts.db so the synthesis is in ranked search ..."
  bash "$ROOT/bin/build-fts.sh"
fi
