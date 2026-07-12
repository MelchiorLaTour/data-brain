#!/usr/bin/env bash
# delete-candidates.sh — scan the indexed corpus and emit a DELETE-CANDIDATES LIST. LIST ONLY.
# This script NEVER deletes, moves, or renames anything. It writes one report file
# (DELETE-CANDIDATES.md at the project root) that the owner reviews and acts on by hand.
#
# Hard PROTECT rules (these are NEVER listed as delete candidates):
#   - Writing iterations: anything whose name carries resume/cv/letter/lettre/essay/essai/
#     motivation/cover/recommendation/draft/brouillon  (drafts are records worth keeping).
#   - EDIT the PROTECT regex below to add your own permanent-keep keywords.
# Dedup rule (per NewBrain project rule): a NAME match is NEVER proof. Every duplicate is flagged
# "VERIFY byte-identical (cmp) before deleting" — confirmation is the owner's, on the real files.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
OUT="$ROOT/DELETE-CANDIDATES.md"
TS="$(date '+%Y-%m-%d %H:%M')"

PROTECT='resume|cv|letter|lettre|essay|essai|motivation|cover|recommendation|recomendation|draft|brouillon'
GENERIC='^(README|readme|FACTS|CLAUDE|PLAN|INDEX|index|MEMORY|ROUTING|MAP|PICKUP|SESSION_STATE|CHANGELOG|LICENSE|TODO|NOTES)\.'

tmpd="$(mktemp -d)"; trap 'rm -rf "$tmpd"' EXIT
all="$tmpd/all"

# Every note-like file across the corpus (same scope + prune as ingest-root.sh).
for root in "${CANON[@]}"; do
  [ -d "$root" ] || continue
  find "$root" -type f \( -name '*.md' -o -name '*.txt' -o -name '*.pdf' \
     -o -name '*.docx' -o -name '*.doc' -o -name '*.pages' -o -name '*.rtf' \
     -o -name '*.bak' -o -name '*.old' -o -name '*.orig' -o -name '*.tmp' \) \
     "${PRUNE_FIND[@]}" 2>/dev/null
done | sort -u > "$all"

is_protected () { echo "$1" | grep -qiE "$PROTECT"; }

# --- Category A: Finder/duplicate-suffix copies ("name 2.ext", "name (1).ext", "name copy.ext") ---
# ONLY flag when the DE-SUFFIXED original exists in the SAME folder — otherwise a title that simply
# ends in a number ("... 2026.md", "... week 1.md", "Part 1.pdf") is a false positive, not a copy.
catA="$tmpd/A"
: > "$catA"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  d="$(dirname "$f")"; b="$(basename "$f")"
  case "$b" in
    *" "[0-9]*.*|*"("[0-9]*")"*.*|*" copy"*.*|*" Copy"*.*) : ;;
    *) continue ;;
  esac
  orig="$(printf '%s' "$b" | sed -E 's/ ([0-9]+|\([0-9]+\)|[Cc]opy( [0-9]+)?)(\.[A-Za-z0-9]+)$/\3/')"
  [ "$orig" != "$b" ] && [ -f "$d/$orig" ] && echo "$f" >> "$catA"
done < "$all"

# --- Category B: backup/temp/old artifacts by extension ---
catB="$tmpd/B"
grep -E '\.(bak|old|orig|tmp)$|~$' "$all" > "$catB" 2>/dev/null || true

# --- Category C: stale process scaffolding under ~/Claude (PICKUP/SESSION_STATE/-OLD/-SUPERSEDED...) ---
catC="$tmpd/C"
grep -E "$HOME/Claude/" "$all" 2>/dev/null \
  | grep -iE '(PICKUP|SESSION_STATE|-OLD|_OLD|-SUPERSEDED|-DEPRECATED|-STALE|-BACKUP|\.bak)' > "$catC" 2>/dev/null || true

# --- Category D: same basename in 2+ locations (non-generic) -> possible redundant copies ---
catD="$tmpd/D"
while IFS= read -r f; do printf '%s\t%s\n' "$(basename "$f")" "$f"; done < "$all" \
  | sort > "$tmpd/by_base"
# basenames that occur >1 time, excluding generic per-project filenames
dupbases="$(cut -f1 "$tmpd/by_base" | uniq -d | grep -vE "$GENERIC" || true)"
: > "$catD"
while IFS= read -r b; do
  [ -n "$b" ] || continue
  awk -F'\t' -v B="$b" '$1==B{print $2}' "$tmpd/by_base" >> "$catD"
  echo "---" >> "$catD"
done <<< "$dupbases"

# size helper
sz () { du -h "$1" 2>/dev/null | cut -f1; }

emit_simple () {  # $1=file list, $2=reason
  local lf="$1" reason="$2" n=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    is_protected "$f" && continue
    echo "- [ ] \`$(echo "$f" | sed "s#$HOME#~#")\`  ($(sz "$f")) — $reason"
    n=$((n + 1))
  done < "$lf"
  echo "_($n candidates)_"
}

{
  echo "# NewBrain — Delete-Candidates List"
  echo ""
  echo "_Generated $TS by \`bin/delete-candidates.sh\`. **LIST ONLY — nothing here is deleted.**_"
  echo "_Review each box; delete by hand ONLY after you confirm it. Duplicates: \`cmp\`-verify byte-identical first._"
  echo "_PROTECTED + never listed: writing iterations (resume/cv/letter/essay/motivation/cover/recommendation/draft)._"
  echo ""
  echo "## A. Finder duplicate-suffix copies (\"name 2\", \"name (1)\", \"name copy\")"
  echo "_Likely accidental Finder duplicates. Verify the original exists + is identical before removing._"
  emit_simple "$catA" "duplicate-suffix copy — verify original"
  echo ""
  echo "## B. Backup / temp artifacts (.bak .old .orig .tmp ~)"
  emit_simple "$catB" "backup/temp artifact"
  echo ""
  echo "## C. Stale process scaffolding under ~/Claude (PICKUP / SESSION_STATE / -OLD / -SUPERSEDED)"
  echo "_Old AI session handoffs + superseded plans. Safe to clear once their work is captured in FACTS/memory._"
  emit_simple "$catC" "stale scaffolding — confirm superseded"
  echo ""
  echo "## D. Same filename in 2+ locations (non-generic) — possible redundant copies"
  echo "_Grouped by name; \`cmp\` each pair before deleting. A name match is NOT proof of redundancy._"
  {
    grp_count=0
    while IFS= read -r line; do
      if [ "$line" = "---" ]; then echo ""; continue; fi
      is_protected "$line" && continue
      echo "- [ ] \`$(echo "$line" | sed "s#$HOME#~#")\`  ($(sz "$line"))"
    done < "$catD"
  }
} > "$OUT"

echo "wrote $OUT"
echo "  A(suffix-dupes)=$(grep -c '^- \[ \]' <<<"$(emit_simple "$catA" x)" 2>/dev/null || echo '?')  (see file for full counts)"
