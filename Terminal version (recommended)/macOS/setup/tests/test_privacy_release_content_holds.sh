#!/usr/bin/env bash
# Part 40 (0.2.1): when the privacy rules change, a file the old rules held for its TEXT, with no decision from the user, is let go from the held list so
# the current rules screen it again. Name and folder holds, and the user's own decisions (allowed = kept, excluded), stay exactly as they are.
# Invented paths only. Usage: test_privacy_release_content_holds.sh [engine root]
set -euo pipefail
ENGINE="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-p40rel.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export NB_PRIVACY_FILE="$SCRATCH/privacy.tsv"
fail() { echo "FAIL: $*" >&2; exit 1; }
T=$'\t'
cat > "$NB_PRIVACY_FILE" <<EOF
held${T}/fake/Notes/code-python.md${T}contains a password
held${T}/fake/Notes/statement.txt${T}looks like a bank statement or login details (several signs together)
held${T}/fake/Notes/iban.txt${T}contains an IBAN
held${T}/fake/Notes/passport-copy.md${T}name "passport" looks private
held${T}/fake/Banque/letter.md${T}folder "Banque" looks private
held${T}/fake/Notes/kept.md${T}contains a password
allowed${T}/fake/Notes/kept.md${T}contains a password
held${T}/fake/Notes/excluded.md${T}contains a password
excluded${T}/fake/Notes/excluded.md${T}contains a password
EOF
chmod 600 "$NB_PRIVACY_FILE"
/usr/bin/perl "$ENGINE/bin/privacy.pl" release-content-holds || fail "release-content-holds failed"
have() { grep -Fqx -- "$1" "$NB_PRIVACY_FILE"; }
for gone in code-python.md statement.txt iban.txt; do
  ! grep -Fq "/fake/Notes/$gone" "$NB_PRIVACY_FILE" || fail "$gone was held for its text with no decision: it must be let go for a new screen"
done
have "held${T}/fake/Notes/passport-copy.md${T}name \"passport\" looks private" || fail "a name hold stays"
have "held${T}/fake/Banque/letter.md${T}folder \"Banque\" looks private" || fail "a folder hold stays"
have "allowed${T}/fake/Notes/kept.md${T}contains a password" || fail "the user's keep decision stays"
have "excluded${T}/fake/Notes/excluded.md${T}contains a password" || fail "the user's exclude decision stays"
[ "$(stat -f %Lp "$NB_PRIVACY_FILE")" = 600 ] || fail "the held list keeps its permissions"
# no held list: nothing to do, no file created
rm -f "$NB_PRIVACY_FILE"; /usr/bin/perl "$ENGINE/bin/privacy.pl" release-content-holds || fail "a missing list is not an error"
[ ! -e "$NB_PRIVACY_FILE" ] || fail "no held list is created"
echo 'PASS: on a rules change, text holds with no user decision are let go for a new screen; name, folder, kept and excluded lines stay'
