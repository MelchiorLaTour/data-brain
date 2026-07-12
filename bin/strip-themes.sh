#!/usr/bin/env bash
# strip-themes.sh — remove the seed `theme:` line from each vault note's frontmatter, so labels
# live ONLY in moc/index.tsv (Option B single source of truth, decided 2026-06-20).
# REVERSIBLE: re-stamp from index.tsv if ever needed. Edits content only — never moves a file.
# Strips ONLY a `theme:` line that sits inside the FIRST frontmatter block (before the 2nd `---`),
# so a literal "theme:" in body text is never touched. Idempotent: a note with no frontmatter
# theme line is left as-is. Run AFTER bin/build-index.sh has captured the labels.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"

stripped=0; scanned=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  scanned=$((scanned + 1))
  # does it have a theme line inside the first frontmatter block?
  if ! sed -n '2,/^---/p' "$f" | grep -q '^theme:'; then
    continue
  fi
  tmp="$(mktemp)"
  awk 'BEGIN{c=0} /^---[[:space:]]*$/{c++} { if(c<2 && /^theme:/){next} print }' "$f" > "$tmp"
  # safety: only replace if the strip removed exactly the theme line(s) and nothing else broke
  if [ -s "$tmp" ]; then
    mv "$tmp" "$f"
    stripped=$((stripped + 1))
  else
    rm -f "$tmp"
    echo "WARN: skipped (empty result) $f" >&2
  fi
done < <(
  for root in "${CANON[@]}"; do
    [ -d "$root" ] || continue
    find "$root" -type f -name '*.md' "${PRUNE_FIND[@]}"
  done | sort
)

echo "stripped theme: line from $stripped notes (scanned $scanned)"
