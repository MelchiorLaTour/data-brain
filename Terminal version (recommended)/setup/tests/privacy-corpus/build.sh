#!/usr/bin/env bash
# Part 40 corpus: build the invented documents into <out>/everyday (ordinary, must never be held) and <out>/vaultish (real secrets, must stay held).
# name.as-pdf.txt becomes name.pdf (shaped like a Google Docs export), name.as-docx.txt becomes name.docx (textutil); md and txt are copied.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
OUT="${1:?usage: build.sh <out dir>}"
for pair in ordinary:everyday secret:vaultish; do
  src="$HERE/${pair%%:*}"; dst="$OUT/${pair##*:}"
  mkdir -p "$dst"
  for f in "$src"/*; do
    name="$(basename "$f")"
    case "$name" in
      *.as-pdf.txt)  /usr/bin/perl "$HERE/make-pdf.pl" "$f" "$dst/${name%.as-pdf.txt}.pdf" ;;
      *.as-docx.txt) /usr/bin/textutil -convert docx -output "$dst/${name%.as-docx.txt}.docx" "$f" ;;
      *)             cp "$f" "$dst/$name" ;;
    esac
  done
done
