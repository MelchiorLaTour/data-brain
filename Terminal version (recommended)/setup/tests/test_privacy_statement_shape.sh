#!/usr/bin/env bash
# Part 16 (0.2.1): content-based holding of bank-statement and login SHAPES. A file is held (for the user's review, never excluded) only when
# 2 or more signs appear together: (1) an account or masked card number with its label, (2) a bank name with 2+ distinct statement words, and
# a second sign for the strong statement shape (2+ bank mentions with 4+ distinct statement words), (3) login fields (user label AND password label).
# One sign alone never holds. Invented text only.
set -euo pipefail
ENGINE="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-stmt.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export NB_PRIVACY_FILE="$SCRATCH/privacy.tsv"
fail() { echo "FAIL: $*" >&2; exit 1; }
WHY='looks like a bank statement or login details (several signs together)'
reason() { : > "$NB_PRIVACY_FILE"; printf '%s\n' "$1" | /usr/bin/perl "$ENGINE/bin/privacy.pl" content "$SCRATCH/note.md"; }
held() { [ "$(reason "$1")" = "$WHY" ] || fail "must be held for several signs: $1 (got: $(reason "$1"))"; }
free() { [ -z "$(reason "$1")" ] || fail "must NOT be held: $1 (got: $(reason "$1"))"; }

# the shape of a keyword file made from a statement: no digits at all, two bank mentions, four or more statement words
held 'statement, checking, debit, balance, chase, jpmorgan chase bank, deposit, card'
held 'Statement of the checking account. Beginning balance and the deposit total are shown. JPMorgan Chase Bank, Chase Total Checking.'
# a bank, two statement words and an account number with its label
# (a labelled account or routing number now holds on its own, with its own reason, see test_privacy_secret_gaps.sh)
# a login template (labels only, no value) with a masked card ending
held 'Portal login
username:
password:
card ending xxxx4821'
# a masked card ending beside a bank name and two statement words
held 'Bank of America debit statement, card ending xxxx4821'

# one sign alone is never enough
free 'I opened a Chase account last year and I like it.'
free 'My Chase checking balance is fine.'
free 'Budget note: balance, deposit and withdrawal this month, nothing else.'
free 'statement, checking, debit, balance, deposit, withdrawal for the budget spreadsheet'
free 'Chase the dream. Chase the dream. Statement of purpose draft.'
free 'username:
password:'
# the existing rule for a login with values still holds, with its own reason
[ "$(reason 'username: demo
password: x9k2m4qz')" = 'contains a password' ] || fail 'a login with values is still held as a password'
echo 'PASS: a bank-statement or login shape is held only when 2 or more signs appear together; single signs, bank mentions and budget words stay searchable'
