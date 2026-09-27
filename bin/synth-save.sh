#!/usr/bin/env bash
# synth-save.sh — wire a Claude-produced SYNTHESIS back into the brain as a new note, so derived
# knowledge accumulates ("the brain compounds" — corpus-hygiene decision 4, 2026-07-05).
#
# THE CONVENTION (Claude-side, see sectors/brain.md): when Claude produces a synthesis in a brain
# context, it (1) shows the synthesis, (2) asks ONE inline "wire this into the brain? [keep/drop]",
# and (3) ONLY on "keep" runs this script. Nothing is ever wired in without that yes (a wrong
# synthesis would poison future retrievals). Raw/ambiguous captures still go to INBOX.md via capture.sh.
#
# A synthesis is new authored content, so it gets a real home under an approved source root.
# It is then indexed in place. Pure bash / Claude-OFF safe; body read from stdin.
#
# Usage:  bin/synth-save.sh "Human Title" "theme1,theme2" [keywords]  <<'EOF'
#         ...synthesis markdown body...
#         EOF
#   env SYNTH_SKIP_FTS=1  skips the fts.db rebuild (batch several saves, then run build-fts.sh once).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
# Override only with another directory inside a selected source root.
DEST_DIR="${SYNTH_DEST:-$VAULT/brain-syntheses}"
TITLE="${1:-}"; THEMES="${2:--}"; KEYWORDS="${3:-${2:-}}"
[ -n "$TITLE" ] || { echo "usage: synth-save.sh \"Title\" [themes] [keywords]   (body on stdin)" >&2; exit 1; }
case "$TITLE$THEMES$KEYWORDS" in *$'\n'*|*$'\r'*|*$'\t'*) echo 'synth-save: title, themes, and keywords cannot contain tabs or line breaks' >&2; exit 1 ;; esac

body="$(cat)"
[ -n "$body" ] || { echo "synth-save: empty body on stdin — nothing saved" >&2; exit 1; }

if ! is_approved_directory_path "$DEST_DIR"; then
  echo "synth-save: destination is not inside an approved source folder: $DEST_DIR" >&2
  exit 1
fi
if [ ! -d "$DEST_DIR" ]; then mkdir "$DEST_DIR" || { echo "synth-save: could not create $DEST_DIR" >&2; exit 1; }; fi
is_approved_directory_path "$DEST_DIR" || { echo 'synth-save: destination changed or is no longer approved' >&2; exit 1; }
d="$(date '+%Y-%m-%d')"
# keep the human title in the filename; strip only filesystem-hostile chars
slug="$(printf '%s' "$TITLE" | tr '/' '-' | tr ':' '-' | tr -d '[:cntrl:]')"
dest=''; created=0
umask 077
KEYWORDS_NORM="$(printf '%s' "$KEYWORDS" | tr ',' '\n' | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//' | awk 'NF && !seen[$0]++' | paste -sd, - || true)"
[ -n "$KEYWORDS_NORM" ] || { echo 'synth-save: provide 2–12 distinct search keywords' >&2; exit 1; }
IFS=',' read -ra keyword_list <<< "$KEYWORDS_NORM"
[ "${#keyword_list[@]}" -ge 2 ] && [ "${#keyword_list[@]}" -le 12 ] || {
  echo 'synth-save: provide 2–12 distinct search keywords (third argument); at least two themes can serve as the default' >&2
  exit 1
}
for keyword in "${keyword_list[@]}"; do
  [[ "$keyword" =~ ^[a-z0-9][a-z0-9_-]{1,39}$ ]] || {
    echo "synth-save: invalid search keyword '$keyword' (use 2–40 lowercase letters, digits, _ or -)" >&2
    exit 1
  }
done
for ((n=0; n<100; n++)); do
  suffix=''; [ "$n" -eq 0 ] || suffix=" ($n)"
  candidate="$DEST_DIR/$d $slug$suffix.md"
  if (set -o noclobber; : > "$candidate") 2>/dev/null; then dest="$candidate"; created=1; break; fi
done
[ "$created" -eq 1 ] || { echo "synth-save: no unused filename available for $TITLE" >&2; exit 1; }

if ! {
  printf -- '---\n'
  printf 'type: synthesis\n'
  printf 'source: claude-synthesis\n'
  printf 'created: %s\n' "$d"
  printf 'theme: [%s]\n' "$THEMES"
  printf 'tags: [%s]\n' "$KEYWORDS_NORM"
  printf -- '---\n\n'
  printf '# %s\n\n' "$TITLE"
  printf '%s\n' "$body"
} >> "$dest"; then
  echo "synth-save: synthesis was created but could not be written: $dest" >&2
  exit 1
fi
echo "saved synthesis -> ${dest/#$HOME/~}"

# wire it in: register the row (no copy), refresh the human MOCs
bash "$ROOT/bin/index-add.sh" "$dest" "$THEMES" "$KEYWORDS_NORM"
bash "$ROOT/bin/rebuild.sh" >/dev/null
echo 'rebuilt MOCs'

# make it findable by the PRIMARY ranked search (fts.sh). search.sh (live full-text) already
# reaches it with no rebuild; fts.db needs a rebuild to include it.
if [ "${SYNTH_SKIP_FTS:-0}" = "1" ]; then
  echo "fts.db NOT rebuilt (SYNTH_SKIP_FTS=1) — run: bash bin/build-fts.sh when done batching"
else
  echo "rebuilding fts.db so the synthesis is in ranked search ..."
  bash "$ROOT/bin/build-fts.sh"
fi
bash "$ROOT/bin/inventory.sh"
