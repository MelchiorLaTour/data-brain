#!/usr/bin/env bash
# build-index.sh — ONE-TIME seeder for moc/index.tsv (the side index = label source of truth).
# Reads each note's current `theme:` + `tags:` frontmatter ONCE and writes them into the side
# index, so labels can then be STRIPPED from the notes (Option B: labels live in the index, not
# inside the real files). After this seed runs and the notes are stripped, index.tsv is the
# master: new/non-markdown files are added to it directly (e.g. by file-note.sh), never by
# re-reading note frontmatter. rebuild.sh draws the human MOCs FROM this file.
#
# Format (TSV): canonical_path \t title \t themes \t keywords
#   themes   = comma-list, multi-label preserved (a note can belong to several rooms by design)
#   keywords = comma-list seeded from the note's own `tags:` (minus the generic `user` tag and
#              bare 4-digit years); search-acceleration only — full-text rg stays the safety net.
set -uo pipefail   # NOTE: no `-e` — this is a data-munging loop; empty greps are normal, not fatal.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
OUT="$ROOT/moc/index.tsv"
mkdir -p "$ROOT/moc"

printf '# canonical_path\ttitle\tthemes\tkeywords\n' > "$OUT"

notes="$(mktemp)"; trap 'rm -f "$notes"' EXIT
for root in "${CANON[@]}"; do
  [ -d "$root" ] || continue
  find "$root" -type f -name '*.md' "${PRUNE_FIND[@]}"
done | sort > "$notes"

total=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  total=$((total + 1))
  title="$(basename "$f" .md | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2} //')"
  canon="${f/#$HOME/~}"
  # frontmatter = lines 2..first closing --- (same slice rebuild.sh uses)
  fm="$(sed -n '2,/^---/p' "$f")"
  # themes: `theme: [a, b]` OR `theme: a` -> comma-list, whitespace stripped
  themes="$(printf '%s\n' "$fm" | sed -n -e 's/^theme:[[:space:]]*\[\(.*\)\][[:space:]]*$/\1/p' -e 's/^theme:[[:space:]]*\([^[].*\)$/\1/p' | head -1 | tr -d '[:space:]')"
  # keywords from `tags: [ ... ]`; drop the generic `user` tag and bare years
  kw="$(printf '%s\n' "$fm" | sed -n 's/^tags:[[:space:]]*\[\(.*\)\].*$/\1/p' | head -1 \
        | tr ',' '\n' | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//' \
        | grep -viE '^(user)$' | grep -vE '^[0-9]{4}$' | paste -sd, -)"
  printf '%s\t%s\t%s\t%s\n' "$canon" "$title" "${themes:--}" "${kw:--}" >> "$OUT"
done < "$notes"

echo "seeded: $total notes -> $OUT"
