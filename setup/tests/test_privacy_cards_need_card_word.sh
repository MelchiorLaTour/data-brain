#!/usr/bin/env bash
# 0.1.38: a number is held as a card only with a real card layout + Luhn + a card word within ~80 characters. Invented numbers (public test PANs).
set -euo pipefail
ENGINE="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-card.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export NB_PRIVACY_FILE="$SCRATCH/privacy.tsv"
fail() { echo "FAIL: $*" >&2; exit 1; }
reason() { : > "$NB_PRIVACY_FILE"; printf '%s\n' "$1" | /usr/bin/perl "$ENGINE/bin/privacy.pl" content "$SCRATCH/note.md"; }
held() { [ "$(reason "$1")" = 'contains a card number' ] || fail "must be held: $1"; }
free() { [ -z "$(reason "$1")" ] || fail "must NOT be held: $1"; }

held 'Visa card 4111 1111 1111 1111 exp 12/29'
held 'carte bancaire: 5555555555554444 cvv 123'
held 'Mastercard 2223000048400011'
held 'amex 378282246310005'
held 'Discover 6011111111111117 expiry 01/30'
held '4111-1111-1111-1111 is my CB'
free '4111 1111 1111 1111'
free 'Measurement table: 4111111111111111 then 5555555555554444 and 378282246310005'
free 'invoice 4012888888881881 total due next week'
# a Luhn-valid 16-digit run with no real card prefix is data, even beside a card word
free 'card 9999999999999995'
free 'card 1234567890123452'
# a card word 200 characters away does not count
far="card $(printf 'x%.0s' $(seq 1 200)) 4111111111111111"
free "$far"
echo 'PASS: cards need a real layout, Luhn and a nearby card word'
