#!/usr/bin/env bash
# restore-themes.sh — REVERSE of strip-themes.sh. Re-inserts the `theme: [...]` line into each
# themed note's frontmatter, read from moc/index.tsv (the source of truth). Restores the notes to
# their pre-strip state. Idempotent: a note that already has a frontmatter theme line is skipped.
# Edits content only — never moves a file.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/moc/index.tsv"
[ -s "$INDEX" ] || { echo "error: $INDEX missing" >&2; exit 1; }

restored=0; skipped=0; missing=0
while IFS=$'\t' read -r canon title themes keywords; do
  [ -n "${canon:-}" ] || continue
  case "$canon" in \#*) continue ;; esac
  [ "${themes:-}" = "-" ] || [ -z "${themes:-}" ] && continue   # only re-stamp themed notes
  # expand leading ~ to $HOME
  f="${canon/#\~/$HOME}"
  [ -f "$f" ] || { missing=$((missing+1)); echo "WARN missing: $f" >&2; continue; }
  # already has a frontmatter theme line? skip (idempotent)
  if sed -n '2,/^---/p' "$f" | grep -q '^theme:'; then skipped=$((skipped+1)); continue; fi
  themeline="theme: [$(printf '%s' "$themes" | sed 's/,/, /g')]"
  tmp="$(mktemp)"
  awk -v tl="$themeline" 'BEGIN{c=0;done=0}
    /^---[[:space:]]*$/{ c++; if(c==2 && !done){ print tl; done=1 } print; next }
    { print }' "$f" > "$tmp"
  if [ -s "$tmp" ] && grep -q '^theme:' "$tmp"; then mv "$tmp" "$f"; restored=$((restored+1)); else rm -f "$tmp"; echo "WARN failed: $f" >&2; fi
done < "$INDEX"

echo "restored theme: line to $restored notes (skipped $skipped already-themed, $missing missing)"
