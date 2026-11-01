#!/usr/bin/env bash
# 0.1.38: short account labels (pass, pwd, pin, code, login, username, identifiant, user id) and an email next to a short mixed
# letters+digits token are held. All text below is invented.
set -euo pipefail
ENGINE="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-pwide.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export NB_PRIVACY_FILE="$SCRATCH/privacy.tsv"
fail() { echo "FAIL: $*" >&2; exit 1; }
reason() { : > "$NB_PRIVACY_FILE"; printf '%s\n' "$1" | /usr/bin/perl "$ENGINE/bin/privacy.pl" content "$SCRATCH/note.md"; }

while IFS= read -r text; do
  [ -n "$text" ] || continue
  [ "$(reason "$text")" = 'contains a password' ] || fail "must be held: $text"
done <<'HELD'
pass: Bear2019x
pwd = zeta99
PIN: 4821
pin 4821
login: jdoe
Username: jane.roe42
identifiant : jr4829
user id: 55-ab
temporary pass: Welcome1
code: 90210
HELD
# the Berkeley shape: an email and a short mixed token a few lines apart, no label at all
[ "$(reason $'College email\nsample.person@example.edu\n\nnote to self\nc014d1')" = 'contains a password' ] || fail "email + mixed token within 3 lines must be held"
[ "$(reason $'order confirmation for sample.person@example.edu\nreference A1B2C3D4')" = 'contains a password' ] || fail "ticket code next to an email is held (no exemptions, Mel's wide choice)"

while IFS= read -r text; do
  [ -n "$text" ] || continue
  [ -z "$(reason "$text")" ] || fail "must NOT be held: $text"
done <<'FREE'
I should write down my login steps for the portal.
Use the passage on page 4 for the essay.
Email sample.person@example.edu about the meeting on Tuesday.
The pin board in the hall is full.
FREE
# an email with a mixed token 5 lines away is outside the window
[ -z "$(reason $'sample.person@example.edu\n1\n2\n3\n4\nc014d1')" ] || fail "a token more than 3 lines from the email is not paired"
echo 'PASS: wide labels and email+token pairs are held; plain mentions are not'
