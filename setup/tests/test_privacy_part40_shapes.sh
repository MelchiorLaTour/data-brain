#!/usr/bin/env bash
# Part 40 (0.2.1): ordinary school and work text was held as "contains a password". One line per false-positive shape (must NOT be held) and one per
# real-secret shape (must be held), in English and French. Every value below is invented. Usage: test_privacy_part40_shapes.sh [engine root]
set -euo pipefail
ENGINE="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-p40.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
export NB_PRIVACY_FILE="$SCRATCH/privacy.tsv"
FAILS=0
fail() { echo "FAIL: $*" >&2; FAILS=$((FAILS+1)); }
reason() { : > "$NB_PRIVACY_FILE"; printf '%s\n' "$1" | /usr/bin/perl "$ENGINE/bin/privacy.pl" content "$SCRATCH/note.md"; }
free() { local got; got="$(reason "$1")"; [ -z "$got" ] || fail "[$2] must NOT be held (got: $got)"; }
held() { local got; got="$(reason "$1")"; [ -n "$got" ] || fail "[$2] must be held"; }

# --- F1 short labels (pass, code, pin, login) in prose: the value is an ordinary word and more text follows on the line
free 'For the first pass: read the abstract, then the conclusion.'                         F1-pass-prose-en
free 'Premier pass: relire les sources avant la soutenance.'                                F1-pass-prose-fr
free 'Code: Python, with pandas and scikit-learn for the models.'                           F1-code-word-en
free 'Code : R et Python pour le nettoyage des donnÃÂÃÂ©es.'                                    F1-code-word-fr
free 'Code: python'                                                                         F1-code-word-alone-en
free 'code : python'                                                                        F1-code-word-alone-fr
free 'Login: required to download the dataset from the course page.'                        F1-login-prose-en
free 'PIN: see the back of your student card'                                               F1-pin-word-en
free 'Login: with your school account on the portal'                                      F1-login-value-then-prose
# --- F2 qualified codes and URL parameters: a zip, course, country, status, promo or dress code is not a secret
free 'Zip code: 90210'                                                                      F2-zip-en
free 'Code postal : 59000'                                                                  F2-postal-fr
free 'Course code: FIN2034'                                                                 F2-course-en
free 'Code du cours : FIN2034'                                                                   F2-course-fr-after
free 'Country code: 33'                                                                     F2-country-en
free 'Status code = 200'                                                                    F2-status-en
free 'Promo code: SPRING24'                                                                 F2-promo-en
free 'Dress code: business casual'                                                          F2-dress-en
free 'Grade needed to pass: 10/20'                                                          F2-grade-fr-style
free 'callback https://example.org/auth?code=4f9a2b77c1&state=xyz'                          F2-url-code
# --- F3 code: a password VARIABLE in a script or notebook is not a password
free 'password = input("Enter your password: ")'                                            F3-input
free 'pwd = getpass.getpass()'                                                              F3-getpass
free 'password=os.environ["DB_PASSWORD"]'                                                   F3-environ
free 'password = request.form["password"]'                                                  F3-form
free 'self.password = password_hash'                                                        F3-attr
free 'password: str = Field(min_length=8)'                                                  F3-annotation
free 'mot_de_passe = input("Mot de passe : ")'                                              F3-input-fr
free 'login = None'                                                                         F3-none
free 'DB_PASSWORD=${DB_PASSWORD}'                                                           F3-placeholder
free 'password: <your password>'                                                            F3-angle-placeholder
# --- F4 prose after a strict label: "given in class", "ask at the front desk", "ÃÂÃÂ  demander"
free 'Exam password: given in class on the day of the exam.'                                F4-exam-en
free 'WiFi password: ask at the front desk'                                                 F4-wifi-en
free "Mot de passe de l'examen : donnÃÂÃÂ© en cours le jour mÃÂÃÂªme."                              F4-exam-fr
free 'Mot de passe : ÃÂÃÂ  demander au secrÃÂÃÂ©tariat'                                             F4-ask-fr
free 'Password: required'                                                                   F4-required-en
free 'Mot de passe : obligatoire'                                                           F4-required-fr
# --- F5 an email next to an ID-shaped number, a profile link or a long code line is not a login pair
free $'Alice Martin, alice.martin@example.edu\nStudent ID s20231045'                        F5-student-id-en
free $'Contact : lea.dupont@example.fr\nMatricule : e21904577'                              F5-matricule-fr
free $'bob.lee@example.edu\nS20231187 Ã¢ÂÂ group 3'                                       F5-id-no-label
free $'Jane Roe, jane.roe@example.com\nlinkedin.com/in/jane-roe-4b2a91'                     F5-profile-link
free $'owner: dev@example.org\n'"$(printf 'x%.0s' $(seq 1 130)) a1b2c3d4e5 trailing"        F5-long-line
free 'Group 12 members: bob@example.edu, carol@example.edu; we cleaned the covid19 dataset together.' F5-prose-token
# --- F8 keys read by the program, keyword arguments, course codes beside an email
free 'token = os.getenv("API_TOKEN")'                                                    F8-token-getenv
free 'api_key = os.environ["API_KEY"]'                                                     F8-apikey-environ
free 'user = User.query.filter_by(username=username).first()'                              F8-keyword-arg
free $'Instructor: prof.sample@example.edu\nCourse code: CF3101'                              F8-course-code-email
# --- F6 a published example IBAN (textbooks and bank websites print it) is not anyone's account
free 'Example IBAN format: GB82 WEST 1234 5698 7654 32'                                     F6-example-iban-en
free "Exemple d'IBAN : FR14 2004 1010 0505 0001 3M02 606"                                   F6-example-iban-fr
free "$(printf 'filler line %s about nothing\n' $(seq 1 300))
For example, a French IBAN looks like FR76 3000 6000 0112 3456 7890 189 in the guide." F6-example-iban-late
free 'test transfer, fake IBAN GB82 WEST 1234 5698 7654 32'                              F6-example-iban-fake
# --- F7 a long book or dataset with bank and statement words scattered through it is not a statement
long="$(for i in $(seq 1 400); do printf 'Chapter %s: the economy grew and the river ran on through the valley for many seasons.\n' "$i"; done)"
free "Chase sits in chapter one; the bank of the river.
$long
HSBC, balance, deposit, statement and withdrawal appear in the glossary at the end." F7-scattered-statement

# --- real secrets stay held (EN and FR)
held 'Password: hunter2 (changed in May)'                                                   S-pw-digit-trailing-en
held 'password: sunshine (home wifi)'                                                   S-pw-word-annotated
held 'Home wifi password: sunshine (the old router in the hallway closet)'                S-pw-word-annotated-long
held 'Mot de passe : Soleil2019 ÃÂÃÂ  changer'                                                  S-pw-digit-trailing-fr
held 'password = "Tr0ub4dor&3"'                                                             S-hardcoded-literal
held 'DB_PASSWORD=s3cr3tPass!'                                                              S-env-file
held 'pass: Bear2019x'                                                                      S-pass-label
held 'code: 90210'                                                                          S-code-digits
held 'Code : 4821'                                                                          S-code-digits-fr
held 'Door code: 4821B'                                                                     S-door-code
held 'login: jdoe'                                                                          S-login
held 'identifiant : jr4829'                                                                 S-identifiant-fr
held 'pin 4821'                                                                             S-pin
held $'College email\nsample.person@example.edu\n\nnote to self\nc014d1'                    S-email-token-alone
held $'order confirmation for sample.person@example.edu\nreference A1B2C3D4'                S-email-token-ref
held $'perso: sample.user@example.com\nsampleuser1998'                                    S-email-word-year
held 'the wifi password is sunshine'                                                        S-wifi-is
held 'le mot de passe est soleil'                                                           S-mdp-est
held 'IBAN: FR68 3000 4012 3400 0077 7888 999'                                              S-iban-fr
held 'IBAN DE18 5001 0517 0000 9876 5432'                                                   S-iban-de
held 'statement, checking, debit, balance, chase, jpmorgan chase bank, deposit, card'      S-statement-keywords
held "https://example.org/login?password=Xq7pL2z9"                                          S-url-password
held 'pay to FR7630006000011234567890189 please'                                         S-example-iban-no-example-word
# --- Part 43: the four gaps Part 40 left open, each closed by a narrow shape; the ordinary near-misses beside each stay free
# G1 a strict label that starts the line, one plain word, then a short note (at most 4 words)
held 'Password: sunshine for the home wifi'                                               G1-word-note-en
held 'Mot de passe : soleil pour la box'                                                  G1-word-note-fr
free 'Password: choose one you will remember easily'                                      G1-near-instruction-en
free 'Mot de passe : voir avec le professeur'                                             G1-near-instruction-fr
free 'Password: same as for the library portal'                                           G1-near-same-en
free 'Mot de passe : choisir un mot simple'                                               G1-near-verb-fr
free 'Password: create it at first login'                                                 G1-near-verb-en
free 'In chapter 3 the password: loyalty becomes the theme'                                G1-near-label-midline
free 'The shared password: sunshine is what everyone guesses first, so avoid it.'         G1-near-midsentence
# G2 a one-word code or pass alone on its line, next to a personal email line (a login line with a value is already held on its own)
held $'Email: sample.user@gmail.com\nPass: sunshine'                                       G2-pass-email-en
held $'Courriel : lea.sample@free.fr\nCode : soleil'                                        G2-code-email-fr
free $'Email: prof.sample@example.edu\nCode: Python'                                     G2-near-school-email
free $'Email: prof.sample@example.edu\nPass: midterm'                                      G2-near-school-word
free $'Contact: jane.roe@gmail.com\nCode: Python'                                         G2-near-language
free $'Contact : lea.sample@free.fr\nCode : R'                                             G2-near-language-fr
free $'sample.user@gmail.com\nCode: Python, with pandas for the models.'                 G2-near-code-prose
# G3 an ID-shaped token alone on the line beside a bare personal email (not a school or work address)
held $'sample.user@gmail.com\nab123456'                                                  G3-id-webmail-en
held $'perso : lea.sample@free.fr\nlp2019875'                                            G3-id-webmail-fr
free $'bob.lee@example.edu\nS20231187'                                                   G3-near-school
free $'sample.user@gmail.com\nAB123456 – group 3, room B204'                                 G3-near-not-alone
free $'Jane Roe â jane.roe@gmail.com â Paris office, analyst\nAB123456'              G3-near-contact-line
free $'sample.user@gmail.com\nStudent ID s20231045'                                       G3-near-labelled-id
# G4 a gift card code is a secret; promo and booking codes are not (booking stays open: see the report)
held 'Gift code: 7GH2K9PL44QX'                                                            G4-gift-en
held 'Code carte cadeau : 7GH2K9PL'                                                       G4-gift-fr
free 'Promo code: SPRING24'                                                               G4-near-promo
free 'Booking code: QX7R2M'                                                               G4-near-booking
# --- Part 43b: a key or secret whose label ends a longer name (env files, JSON, connection strings), value of 20+ mixed letters and digits
held 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYzQ8vT2kLm9Xa'                    K-aws-env
held 'aws_secret_access_key = Hk3s9QpLm2Vx8RtZ1yNc4BwJ7eUa0Df5Gq6Ti'                    K-aws-ini
held 'MY_APP_SECRET=Zq8Lm2Kx9Pv4Rt7Wb1Nc5Yd3Hf6'                                         K-app-secret
held 'GITHUB_TOKEN=a7Kd93LmQ2xZ8vT4pR1nW6yB5cH0eF'                                      K-ci-token
held 'OPENAI_API_KEY=Pq4Ld8Xz2Mv7Tn1Rb9Kc3Wy6Hf5'                                       K-api-key-env
held '"client_secret": "a8Fk2pQz9Lm4Xv7Rt1Yb3Nc6"'                                       K-gcp-json
held '"private_key_id": "9f2c4e8a1b7d3f6e0c5a2b9d8e7f1a3c4b6d2e0f"'                     K-gcp-key-id
held 'DefaultEndpointsProtocol=https;AccountName=demo;AccountKey=Q2x8Lm4Vz7Kp1Rt9Nb3Wc6Yd5Hf0Jg==' K-azure-conn
held 'sas_token: sv2022x11x02ss9bfqt7srt8sco4sp9rwdlacupiytfx'                         K-azure-sas
held 'Clé secrète : Xb7Lq2Mz9Kv4Rp1Wt8Nc3Yd6Hf5'                                        K-fr-cle-secrete
held 'clé_api = Mz4Kq9Lx2Vb7Rt1Wn8Pc3Yd6Hf5'                                         K-fr-cle-api
free 'Set your API key in Settings before you run the notebook.'                         K-near-prose
free 'secret_key: <paste here>'                                                          K-near-placeholder
free 'SECRET_KEY=${SECRET_KEY}'                                                         K-near-envvar
free 'aws_secret_access_key = os.environ["AWS_SECRET_ACCESS_KEY"]'                      K-near-environ
free 'GITHUB_TOKEN=your_github_token_here'                                              K-near-your
free 'next_page_token=CAoQAAAAAAAAAAAAAAAAAAAAAAA'                                     K-near-no-digits-letters
free 'see https://example.org/list?next_page_token=Ab12Cd34Ef56Gh78Ij90Kl'              K-near-url-param
free 'session_token_ttl = 36000000000000000000000'                                     K-near-digits-only
free 'csrf_token = generate_csrf_token_for_session_2024'                                K-near-identifier
free 'API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxx'                                              K-near-xxx
[ "$FAILS" -eq 0 ] || { echo "FAIL: $FAILS shape(s)" >&2; exit 1; }
echo 'PASS: part 40 shapes: prose, qualified codes, code variables, ID numbers, profile links, example IBANs and scattered bank words are not held; real secrets are'
