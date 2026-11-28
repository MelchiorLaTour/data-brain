#!/usr/bin/env bash
# The French index (0.1.30): fts_fr.db is a French-only copy of the search index, built with it. Checked here:
#   - it holds the French notes and not the English ones, and is rebuilt only when the main index changed;
#   - an accented question finds its note (the old word split cut "électricien" at the accent), accents are optional, and French function words
#     alone find nothing;
#   - a row that is only in the French copy (the main index no longer has it, e.g. a privacy-held or deleted note) is never shown;
#   - search still works when the French copy is missing.
# Invented notes only.
set -euo pipefail
export NB_FR_INDEX=on   # the French merge is off by default since 0.1.31; this test covers the kept code
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-french-idx.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
src="$SCRATCH/src"; moc="$SCRATCH/brain/moc"; mkdir -p "$src" "$moc"
printf '%s\n' "$src" > "$SCRATCH/roots.txt"
export NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt"
printf '# path\ttitle\tthemes\tkeywords\n' > "$moc/index.tsv"
note() { printf '%s\n' "$3" > "$src/$1.md"; printf '%s\t%s\t-\t-\n' "$src/$1.md" "$2" >> "$moc/index.tsv"; }
note elec 'Contact : électricien' "Mon électricien est Maelle Dorval, téléphone 06 11 22 33 44. Appelez le matin, le cabinet ferme dans la soirée et il faut demander le tarif d’hiver pour les petits travaux."
note gateau 'Recette : gâteau au yaourt' "La recette du gâteau au yaourt est simple : il faut un pot de yaourt, du sucre et de la farine, et on la sert chaude avec du pain dans le jardin pour les amis."
note velo 'Atelier : vélo' "Les freins du vélo sont à régler et la chaîne est à nettoyer pour la sortie de dimanche, il faut aussi les pneus et une chambre à air pour le voyage."
note plumber 'Contact: plumber' "My plumber is Teodor Brandt, phone 06 99 88 77 66. Call in the morning, the office closes at five and the winter rate applies to small jobs."
note cake 'Recipe: yogurt cake' "The yogurt cake recipe is simple: one pot of yogurt, sugar and flour, served warm with bread in the garden for friends and family."
note bike 'Workshop: bike' "The bike brakes need adjusting and the chain needs cleaning for the Sunday ride, and I also need tyres and a spare inner tube for the trip."
bash "$PROJECT_ROOT/bin/build-fts.sh" > "$SCRATCH/build.log" 2>&1 || { cat "$SCRATCH/build.log" >&2; fail "build failed"; }
fr="$moc/fts_fr.db"
[ -f "$fr" ] || fail "the build must make fts_fr.db"
paths="$(/usr/bin/sqlite3 -readonly "$fr" 'SELECT path FROM notes ORDER BY path;')"
[ "$(printf '%s\n' "$paths" | wc -l | tr -d ' ')" = 3 ] || fail "the French index holds the 3 French notes only, got: $paths"
printf '%s\n' "$paths" | grep -q 'plumber\|cake\|bike' && fail "an English note is in the French index: $paths"

# rebuilt only when the main index changed
m1="$(stat -f %m "$fr")"; sleep 1.1
bash "$PROJECT_ROOT/bin/build-fts.sh" > /dev/null 2>&1
[ "$(stat -f %m "$fr")" = "$m1" ] || fail "an unchanged rebuild must leave the French index alone"
note soupe 'Recette : soupe' "La soupe de légumes est prête pour les enfants : il faut des carottes, du poireau et de la crème dans une grande casserole pour le dîner du dimanche."
sleep 1.1; bash "$PROJECT_ROOT/bin/build-fts.sh" > /dev/null 2>&1
/usr/bin/sqlite3 -readonly "$fr" 'SELECT path FROM notes;' | grep -q 'soupe.md' || fail "a new French note must reach the French index"

hits() { bash "$PROJECT_ROOT/bin/fts.sh" "$@" 2>/dev/null | grep -E '^ *[0-9]+ +-?[0-9.]+ +' || true; }
top() { hits "$@" | head -1 | sed -E 's/^ *[0-9]+ +-?[0-9.]+ +//'; }
[ "$(top 'quel est le numéro de l’électricien')" = "$src/elec.md" ] || fail "an accented question must find the electrician note first; got: $(hits 'quel est le numéro de l’électricien' | head -3)"
[ "$(top 'electricien')" = "$src/elec.md" ] || fail "the same word without the accent also finds it"
[ "$(top 'ÉLECTRICIEN')" = "$src/elec.md" ] || fail "and in capitals"
[ -z "$(hits 'le la les des du de une et pour dans')" ] || fail "French function words alone must find nothing"
[ "$(top 'the plumber phone')" = "$src/plumber.md" ] || fail "an English question still works"

# a row only the French copy has is never shown
/usr/bin/sqlite3 "$fr" "INSERT INTO notes(path,title,themes,keywords,body) VALUES('$src/ghost.md','Fantôme','-','-','le fantomexyz est dans la maison pour les amis et les enfants du village et la famille');"
[ -z "$(hits 'fantomexyz dans la maison')" ] || fail "a row the main index does not have must never be shown, got: $(hits 'fantomexyz dans la maison')"
# no French copy: search still works
rm -f "$fr"
[ "$(top 'quel est le numéro de l’électricien')" = "$src/elec.md" ] || fail "search must still work without the French index"
echo "PASS: the French index holds only French notes and is rebuilt only when the main index changes; accented, unaccented and capital questions find their note; function words alone find nothing; rows only the French copy has are never shown; search works without it."
