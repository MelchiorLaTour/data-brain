#!/bin/bash
# privacy-names.sh — names-only privacy scan, run BEFORE anything is indexed. No file is opened.
# Lists every supported file in the approved folders, flags private-looking file and folder names
# (privacy.pl), and records them as `held` in $NB_PRIVACY_FILE for the user to review.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
[ -n "${NB_PRIVACY_FILE:-}" ] || exit 0
mkdir -p "$(dirname "$NB_PRIVACY_FILE")"
touch "$NB_PRIVACY_FILE"
for root in "${CANON[@]}"; do
  [ -d "$root" ] || continue
  selected_root_find0 "$root" "${PRUNE_DIRS[@]}" -type f \( \
       -name '*.md' -o -name '*.txt' -o -name '*.pdf' \
    -o -name '*.docx' -o -name '*.doc' -o -name '*.pages' -o -name '*.rtf' \) \
    "${PRUNE_FIND[@]}" | tr '\0' '\n'
done | /usr/bin/perl "$ROOT/bin/privacy.pl" names
