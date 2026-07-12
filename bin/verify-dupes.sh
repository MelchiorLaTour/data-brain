#!/usr/bin/env bash
# verify-dupes.sh — REPORT ONLY (deletes nothing). For every duplicate candidate, decide whether it
# is SAFELY verifiable + byte-identical to its twin. Honors the hard rules:
#   - never trust a name match; cmp the actual bytes.
#   - if a file is iCloud-OFFLOADED (dataless, content not on disk) it CANNOT be read -> SKIP, never delete.
# Verdicts: IDENTICAL-LOCAL (safe to delete the copy) | DIFFER | OFFLOADED | MISSING.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"

# readable_local: true only if the file's bytes are actually on disk (not an iCloud dataless stub).
readable_local () {
  local f="$1"
  [ -f "$f" ] || return 1
  [ -r "$f" ] || return 1
  ls -lO "$f" 2>/dev/null | grep -q 'dataless' && return 1   # offloaded -> cannot read
  return 0
}

verdict () {  # $1=copy (delete target) $2=keeper
  local a="$1" b="$2"
  [ -e "$a" ] && [ -e "$b" ] || { echo "MISSING"; return; }
  if ! readable_local "$a" || ! readable_local "$b"; then echo "OFFLOADED"; return; fi
  if cmp -s "$a" "$b"; then echo "IDENTICAL-LOCAL"; else echo "DIFFER"; fi
}

all="$(mktemp)"; trap 'rm -f "$all"' EXIT
for root in "${CANON[@]}"; do
  [ -d "$root" ] || continue
  find "$root" -type f \( -name '*.md' -o -name '*.txt' -o -name '*.pdf' -o -name '*.docx' \
     -o -name '*.doc' -o -name '*.pages' -o -name '*.rtf' \) "${PRUNE_FIND[@]}" 2>/dev/null
done | sort -u > "$all"

PROTECT='resume|cv|letter|lettre|essay|essai|motivation|cover|recommendation|recomendation|draft|brouillon'

echo "========== CATEGORY A — Finder duplicate-suffix copies =========="
echo "(copy = the (1)/(2)/copy file; keeper = de-suffixed original in same dir)"
while IFS= read -r f; do
  b="$(basename "$f")"; d="$(dirname "$f")"
  case "$b" in *" "[0-9]*.*|*"("[0-9]*")"*.*|*" copy"*.*|*" Copy"*.*) : ;; *) continue ;; esac
  echo "$f" | grep -qiE "$PROTECT" && continue
  orig="$(printf '%s' "$b" | sed -E 's/ ([0-9]+|\([0-9]+\)|[Cc]opy( [0-9]+)?)(\.[A-Za-z0-9]+)$/\3/')"
  [ "$orig" != "$b" ] && [ -f "$d/$orig" ] || continue
  v="$(verdict "$f" "$d/$orig")"
  printf '%-16s %s\n' "$v" "$(echo "$f" | sed "s#$HOME#~#")"
done < "$all" | sort

echo ""
echo "========== CATEGORY D — same basename in 2+ locations =========="
GENERIC='^(README|readme|FACTS|CLAUDE|PLAN|INDEX|index|MEMORY|ROUTING|MAP|PICKUP|SESSION_STATE|CHANGELOG|LICENSE|TODO|NOTES|requirements|CONTRIBUTING|SECURITY|SKILL)\.'
awk -F/ '{print $NF"\t"$0}' "$all" | sort > "$all.bybase"
dups="$(cut -f1 "$all.bybase" | uniq -d | grep -vE "$GENERIC" || true)"
while IFS= read -r base; do
  [ -n "$base" ] || continue
  echo "$base" | grep -qiE "$PROTECT" && continue
  # collect this basename's paths (bash 3.2: no mapfile) — keeper = first, compare the rest to it
  keeper="";
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if [ -z "$keeper" ]; then keeper="$p"; continue; fi
    v="$(verdict "$p" "$keeper")"
    printf '%-16s %s  <=>  %s\n' "$v" "$(echo "$keeper"|sed "s#$HOME#~#")" "$(echo "$p"|sed "s#$HOME#~#")"
  done < <(awk -F'\t' -v B="$base" '$1==B{print $2}' "$all.bybase")
done <<< "$dups"
rm -f "$all.bybase"
