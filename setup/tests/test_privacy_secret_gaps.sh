#!/usr/bin/env bash
# Part 16b (0.2.1): secrets that must never reach a model are HELD (for the user's review, never excluded on their own). One line per case, English and
# French. Invented values only. Also: prose that merely talks about passwords or banks stays searchable.
set -euo pipefail
ENGINE="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-secrets.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export NB_PRIVACY_FILE="$SCRATCH/privacy.tsv"
fail() { echo "FAIL: $*" >&2; exit 1; }
reason() { : > "$NB_PRIVACY_FILE"; printf '%s\n' "$1" | /usr/bin/perl "$ENGINE/bin/privacy.pl" content "$SCRATCH/note.md"; }
held() { local want="$1" text="$2" got; got="$(reason "$text")"; [ "$got" = "$want" ] || fail "[$want] expected for: $text (got: ${got:-nothing})"; }
free() { [ -z "$(reason "$1")" ] || fail "must NOT be held: $1 (got: $(reason "$1"))"; }

# 1 password stated in a sentence, no digit
held 'contains a password' 'the wifi password is sunshine'
held 'contains a password' 'le mot de passe est soleil'
# 2 pw / passphrase labels, one password line among normal text
held 'contains a password' 'pw: hunter2abc'
held 'contains a password' 'passphrase: correct horse battery staple'
held 'contains a password' 'Dinner on Friday at eight.
Remember to buy bread.
mdp: Soleil2019
See you there.'
# 3 API key / secret / token labels, and token shapes with no label
held 'contains an access key or token' 'api_key=sk-test-abc123def456ghi789jkl012'
held 'contains an access key or token' 'clé API: abcd1234efgh5678ijkl'
held 'contains an access key or token' 'key AKIAABCDEFGHIJKLMNOP in the file'
held 'contains an access key or token' 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
held 'contains an access key or token' 'xoxb-123456789012-abcdefghijkl'
held 'contains an access key or token' 'here it is sk-proj-abcdefghijklmnop1234567890'
held 'contains an access key or token' 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGH12345'
held 'contains an access key or token' 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'
# 4 recovery (seed) phrase of 12 words
held 'contains a recovery phrase' 'seed phrase: abandon ability able about above absent absorb abstract absurd abuse access accident'
held 'contains a recovery phrase' 'phrase de récupération: abandon ability able about above absent absorb abstract absurd abuse access accident'
# 5 US social security number with its label
held 'contains a social security number' 'SSN: 078-05-1120'
held 'contains a social security number' 'social security number 078 05 1120'
# 6 passport / driving licence / ID number with its label
held 'contains a passport or ID number' 'passport number: 12AB34567'
held 'contains a passport or ID number' 'driver license no. D1234567'
held 'contains a passport or ID number' 'numéro de passeport: 12AB34567'
# 7 bank routing or account number with its label: one sign is enough
held 'contains an account or routing number' 'routing number 021000021'
held 'contains an account or routing number' 'Account number 123456789012'
held 'contains an account or routing number' 'RIB: 30004 00828 00001234567 76'
# 8 security question answers
held 'contains security answers' 'security question: first pet. answer: Dupont'
held 'contains security answers' 'security answer: Dupont'
# 9 two-factor backup codes
held 'contains backup codes' 'backup codes: 1234 5678 9012 3456'
held 'contains backup codes' 'codes de secours: a1b2c3d4 e5f6g7h8 i9j0k1l2'

# prose that only talks about these things stays searchable
free 'I forgot my password again and had to reset it'
free 'went to Chase to open an account today'
free 'Tutorial: set your password in Settings, then sign in.'
free 'The password is required and must be changed every 90 days.'
free 'Une note sur les mots de passe : ils doivent être changés souvent.'
free 'My seed phrase is written down somewhere safe, I should move it.'
free 'The account number field is on the form, fill it in at the bank.'
free 'Backup codes are shown once when you turn on two-factor sign-in.'
echo 'PASS: passwords, passphrases, keys and tokens, recovery phrases, SSNs, passport and licence numbers, labelled account or routing numbers, security answers and backup codes are held in English and French; prose about them stays searchable'
