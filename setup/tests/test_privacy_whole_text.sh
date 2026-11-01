#!/usr/bin/env bash
# The privacy screen reads the WHOLE text (0.1.30). It used to read only the first 400,000 characters, which was harmless while nobody could read
# past the first 1,200; databrain_read now reaches the end of a long file, so a secret placed late must be caught too. Checked here:
#   - an IBAN after character 400,000 is caught (content mode, and filter mode on a long .md file);
#   - an IBAN straddling a 400,000-character window edge is caught;
#   - a long text with nothing private is not held, and an IBAN near the start is still caught.
# Fake IBAN (the standard French example). Fake files only.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(mktemp -d /tmp/databrain-screen-whole.XXXXXX)"   # not under /private: that folder name is itself flagged as private by the name rules
trap 'rm -rf "$SCRATCH"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
IBAN='FR76 3000 6000 0112 3456 7890 189'
filler() { awk -v n="$1" 'BEGIN{for(i=0;i<n;i++) print "ordinary line number " i " about nothing private"}'; }   # about 36 characters a line
screen() { : > "$SCRATCH/held.tsv"; NB_PRIVACY_FILE="$SCRATCH/held.tsv" /usr/bin/perl "$PROJECT_ROOT/bin/privacy.pl" content "$SCRATCH/note.md"; }

{ filler 14000; echo "my account: $IBAN"; } > "$SCRATCH/late.txt"            # the IBAN sits at about character 500,000
[ "$(wc -c < "$SCRATCH/late.txt")" -gt 450000 ] || fail "the late text must be longer than the old 400,000 limit"
[ "$(screen < "$SCRATCH/late.txt")" = "contains an IBAN" ] || fail "an IBAN after character 400,000 must be caught"

filler 11000 > "$SCRATCH/head.txt"; head_part="$(head -c 399990 "$SCRATCH/head.txt")"                                  # the IBAN starts 10 characters before the first window ends
{ printf '%s\n' "$head_part"; printf '%s\n' "$IBAN"; filler 50; } > "$SCRATCH/edge.txt"
[ "$(screen < "$SCRATCH/edge.txt")" = "contains an IBAN" ] || fail "an IBAN straddling a window edge must be caught"

{ echo "my account: $IBAN"; filler 14000; } > "$SCRATCH/early.txt"
[ "$(screen < "$SCRATCH/early.txt")" = "contains an IBAN" ] || fail "an IBAN near the start is still caught"
filler 14000 > "$SCRATCH/clean.txt"
[ -z "$(screen < "$SCRATCH/clean.txt")" ] || fail "a long text with nothing private must not be held"

# filter mode reads a .md file itself: the same late IBAN holds it
cp "$SCRATCH/late.txt" "$SCRATCH/late.md"; cp "$SCRATCH/clean.txt" "$SCRATCH/clean.md"
: > "$SCRATCH/held.tsv"
kept="$(printf '%s\n%s\n' "$SCRATCH/late.md" "$SCRATCH/clean.md" | NB_PRIVACY_FILE="$SCRATCH/held.tsv" /usr/bin/perl "$PROJECT_ROOT/bin/privacy.pl" filter)"
[ "$kept" = "$SCRATCH/clean.md" ] || fail "filter must drop the long .md file with a late IBAN and keep the clean one; kept: $kept"
grep -Fq "held"$'\t'"$SCRATCH/late.md" "$SCRATCH/held.tsv" || fail "the late file is on the held list"
echo "PASS: the privacy screen reads the whole text: an IBAN after character 400,000 or straddling a window edge is caught, in content mode and in filter mode; a clean long text is not held."
