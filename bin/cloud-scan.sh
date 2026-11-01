#!/bin/bash
# cloud-scan.sh — list online-only (dataless) files of supported types in the approved folders, and Google Docs shortcut files.
# Nothing is read or downloaded: it only looks at file flags and sizes. Writes:
#   $MOC/cloud-pending.tsv    path<TAB>size_bytes   (online-only files)
#   $MOC/cloud-shortcuts.tsv  path                  (.gdoc/.gsheet/.gslides: links, not documents)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
MOC="${NB_MOC_DIR:-$ROOT/moc}"
mkdir -p "$MOC"
tmpd="$(mktemp -d "$MOC/.cloud-scan.XXXXXX")"; trap 'rm -rf "$tmpd"' EXIT
: > "$tmpd/all"; : > "$tmpd/shortcuts"
for root in "${CANON[@]}"; do
  [ -d "$root" ] || continue
  selected_root_find0 "$root" "${PRUNE_DIRS[@]}" -type f \( \
       -iname '*.md' -o -iname '*.txt' -o -iname '*.pdf' \
    -o -iname '*.docx' -o -iname '*.doc' -o -iname '*.pages' -o -iname '*.rtf' \) \
    "${PRUNE_FIND[@]}" | tr '\0' '\n' >> "$tmpd/all"
  selected_root_find0 "$root" "${PRUNE_DIRS[@]}" -type f \( -name '*.gdoc' -o -name '*.gsheet' -o -name '*.gslides' \) \
    "${PRUNE_FIND[@]}" | tr '\0' '\n' >> "$tmpd/shortcuts"
done
sort -u "$tmpd/all" | nb_dataless_paths | sort -u > "$tmpd/cloud"
: > "$tmpd/pending"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  size="$(stat -f '%z' "$f" 2>/dev/null || echo 0)"
  printf '%s\t%s\n' "$f" "$size" >> "$tmpd/pending"
done < "$tmpd/cloud"
mv -f -- "$tmpd/pending" "$MOC/cloud-pending.tsv"
sort -u "$tmpd/shortcuts" > "$MOC/cloud-shortcuts.tsv"
echo "cloud-scan: $(wc -l < "$MOC/cloud-pending.tsv" | tr -d ' ') online-only file(s), $(wc -l < "$MOC/cloud-shortcuts.tsv" | tr -d ' ') shortcut(s)"
