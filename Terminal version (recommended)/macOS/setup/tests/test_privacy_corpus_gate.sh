#!/usr/bin/env bash
# Part 40 standing gate (terminal engine): at least 60 invented ordinary documents (school group projects, research plans, Google Docs PDF and Word
# exports, notebooks and scripts with login/password variables, dataset readmes, syllabi with "exam password" prose, CVs, cover letters, meeting
# notes, EN and FR) are NEVER held, and at least 25 invented real secrets are ALL held, by their text (not their name). Each file goes through the
# name rule and then, on the text extract.sh would extract (pdftotext, textutil, or the file itself), the content rules.
# Usage: test_privacy_corpus_gate.sh [engine root]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ENGINE="$(cd "${1:-$HERE/../..}" && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-corpus.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export NB_PRIVACY_FILE="$SCRATCH/privacy.tsv"
bash "$HERE/privacy-corpus/build.sh" "$SCRATCH/corpus"
text_of() {
  case "${1##*.}" in
    pdf)  pdftotext -q "$1" - 2>/dev/null || /usr/bin/osascript -l JavaScript "$ENGINE/setup/mcp/pdf-extract.js" "$1" 2>/dev/null ;;
    docx) /usr/bin/textutil -convert txt -stdout "$1" ;;
    *)    cat "$1" ;;
  esac
}
verdict() {   # prints the reason a file would be held, or nothing
  : > "$NB_PRIVACY_FILE"
  printf '%s\n' "$1" | /usr/bin/perl "$ENGINE/bin/privacy.pl" names
  if [ -s "$NB_PRIVACY_FILE" ]; then cut -f3 "$NB_PRIVACY_FILE"; return; fi
  text_of "$1" | /usr/bin/perl "$ENGINE/bin/privacy.pl" content "$1"
}
ordinary=0; ordinary_held=0; secrets=0; secrets_missed=0
for f in "$SCRATCH"/corpus/everyday/*; do
  ordinary=$((ordinary+1)); why="$(verdict "$f")"
  if [ -n "$why" ]; then ordinary_held=$((ordinary_held+1)); echo "FAIL: ordinary document held: $(basename "$f") ($why)" >&2; fi
done
for f in "$SCRATCH"/corpus/vaultish/*; do
  secrets=$((secrets+1)); why="$(verdict "$f")"
  case "$why" in
    ''|name\ *|folder\ *) secrets_missed=$((secrets_missed+1)); echo "FAIL: real secret not held by its text: $(basename "$f") (${why:-nothing})" >&2 ;;
  esac
done
echo "ordinary: $ordinary, held: $ordinary_held; secrets: $secrets, missed: $secrets_missed"
[ "$ordinary" -ge 60 ] || { echo "FAIL: the corpus needs at least 60 ordinary documents" >&2; exit 1; }
[ "$secrets" -ge 25 ] || { echo "FAIL: the corpus needs at least 25 real secrets" >&2; exit 1; }
[ "$ordinary_held" -eq 0 ] && [ "$secrets_missed" -eq 0 ] || exit 1
echo 'PASS: corpus gate: no ordinary document is held and every real secret is held by its text'
