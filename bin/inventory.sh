#!/usr/bin/env bash
# inventory.sh — reconcile selected-root files against the shared index without reading bodies.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
MOC="${NB_MOC_DIR:-$ROOT/moc}"
INDEX="$MOC/index.tsv"
OUT="$MOC/inventory.tsv"
[ -s "$INDEX" ] || { echo "inventory: index.tsv is missing" >&2; exit 1; }
mkdir -p "$MOC"

tmpd="$(mktemp -d)"; trap 'rm -rf "$tmpd"' EXIT
files="$tmpd/files"; errors="$tmpd/find-errors"; indexed="$tmpd/indexed"
: > "$files"; : > "$errors"
cut -f1 "$INDEX" | sort -u > "$indexed"
# Files held back for privacy review are not gaps: list them apart from the missing ones.
withheld="$tmpd/withheld"; : > "$withheld"
if [ -n "${NB_PRIVACY_FILE:-}" ] && [ -f "$NB_PRIVACY_FILE" ]; then
  awk -F'\t' '{ s[$2]=$1 } END { for (p in s) if (s[p]=="held" || s[p]=="excluded") print p }' "$NB_PRIVACY_FILE" \
    | sed "s#^$HOME#~#" | sort -u > "$withheld"
fi
root_files="$tmpd/root-files"
for root in "${CANON[@]}"; do
  [ -d "$root" ] || { printf '%s\n' "$root: unavailable" >> "$errors"; continue; }
  if selected_root_find0 "$root" "${PRUNE_DIRS[@]}" -type f "${PRUNE_FIND[@]}" > "$root_files" 2>> "$errors"; then
    cat "$root_files" >> "$files"
  else
    printf '%s: traversal failed or selected root changed identity\n' "$root" >> "$errors"
  fi
done

tmpout="$tmpd/inventory.tsv"
printf '# canonical_path\tindex_status\tcontent_status\n' > "$tmpout"
while IFS= read -r -d '' file; do
  canonical="${file/#$HOME/~}"
  base="${file##*/}"
  ext="${base##*.}"
  case "$base" in *.*) ;; *) ext='' ;; esac
  case "$ext" in
    md|txt|pdf|docx|doc|pages|rtf) index_status='eligible' ;;
    *) index_status='unsupported' ;;
  esac
  if [ "$index_status" = unsupported ]; then
    content_status='not_applicable'
  else
    if grep -Fxq "$canonical" "$indexed"; then index_status='indexed'
    elif [ -s "$withheld" ] && grep -Fxq "$canonical" "$withheld"; then index_status='withheld'
    else index_status='missing_index'; fi
    if [ ! -r "$file" ]; then
      content_status='unreadable'
    elif ls -lO "$file" 2>/dev/null | grep -q 'dataless'; then
      content_status='cloud_placeholder'
    elif [ ! -s "$file" ]; then
      content_status='empty'
    else
      content_status='present'
    fi
  fi
  printf '%s\t%s\t%s\n' "$canonical" "$index_status" "$content_status" >> "$tmpout"
done < "$files"
printf '# traversal_errors\t%s\n' "$(wc -l < "$errors" | tr -d ' ')" >> "$tmpout"
mv "$tmpout" "$OUT"
echo "wrote $OUT; traversal_errors=$(wc -l < "$errors" | tr -d ' ')"
