#!/usr/bin/env bash
# A password-style label followed by a value on the same line is held; a note that only talks about passwords is not.
set -euo pipefail
ENGINE="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-pw.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export NB_PRIVACY_FILE="$SCRATCH/privacy.tsv"
fail() { echo "FAIL: $*" >&2; exit 1; }
reason() { : > "$NB_PRIVACY_FILE"; printf '%s\n' "$1" | /usr/bin/perl "$ENGINE/bin/privacy.pl" content "$SCRATCH/note.md"; }

while IFS= read -r text; do
  [ -n "$text" ] || continue
  [ "$(reason "$text")" = 'contains a password' ] || fail "must be held: $text"
done <<'HELD'
Password: hunter2
wifi du salon, mot de passe : Abc123!
Code wifi 12345678
Wifi password is Tr0ub4dor9
MDP=zz9plural
passcode - 4821
Mot de passe : aaaa
  PASSWORD = correct-horse-battery
HELD

while IFS= read -r text; do
  [ -n "$text" ] || continue
  [ -z "$(reason "$text")" ] || fail "must NOT be held: $text"
done <<'FREE'
I need to change my password soon.
The password manager is good, I should use one.
The password is required for the portal.
Remember to set a password:
mot de passe oublié, à réinitialiser
Le code wifi est affiché sur la box.
Passwords are hard; see the security guide.
FREE
# the word on one line and a value on the next line is not a label followed by a value
[ -z "$(reason $'password:\nsomething else entirely')" ] || fail "a value on the next line is not the label's value"
echo 'PASS: password labels with a value on the same line are held; notes that only mention the word are not'
