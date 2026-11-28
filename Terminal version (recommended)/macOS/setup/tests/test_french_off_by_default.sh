#!/usr/bin/env bash
# The French index merge is OFF by default (0.1.31; the 0.1.30 blind test found no gain and four questions ranked worse). Checked here:
#   - a default build makes no fts_fr.db, and removes one left by 0.1.30;
#   - a French copy that exists anyway is never merged into a default search (a marker only the copy holds does not surface);
#   - the accent-aware word split stays: an accented question still finds its note without the French copy;
#   - NB_FR_INDEX=on turns it back on (the copy is built and merged), so the kept code is not dead.
# Invented notes only.
set -euo pipefail
unset NB_FR_INDEX
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-french-off.XXXXXX")" && pwd -P)"
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
build() { bash "$PROJECT_ROOT/bin/build-fts.sh" > "$SCRATCH/build.log" 2>&1 || { cat "$SCRATCH/build.log" >&2; fail "build failed"; }; }
hits() { bash "$PROJECT_ROOT/bin/fts.sh" "$@" 2>/dev/null | grep -E '^ *[0-9]+ +-?[0-9.]+ +' || true; }
top() { hits "$@" | head -1 | sed -E 's/^ *[0-9]+ +-?[0-9.]+ +//'; }
fr="$moc/fts_fr.db"

build
[ ! -e "$fr" ] || fail "a default build must not make fts_fr.db"
# a French copy left by 0.1.30 is removed by the next default build
NB_FR_INDEX=on build; [ -f "$fr" ] || fail "NB_FR_INDEX=on must build fts_fr.db"
build; [ ! -e "$fr" ] || fail "a default build must remove a French index left by 0.1.30"
# a French copy that exists anyway is never merged: plant one with a marker only it holds
NB_FR_INDEX=on build
/usr/bin/sqlite3 "$fr" "UPDATE notes SET title = title || ' frcopyonlymarker', body = body || ' frcopyonlymarker' WHERE path LIKE '%gateau.md';"
on_hits="$(NB_FR_INDEX=on hits 'quel est le numéro de frcopyonlymarker électricien' | sed -E 's/^ *[0-9]+ +-?[0-9.]+ +//')"
printf '%s\n' "$on_hits" | grep -q 'gateau.md' || fail "with NB_FR_INDEX=on the French copy is merged (the marker brings the gateau note in); got: $on_hits"
off_hits="$(hits 'quel est le numéro de frcopyonlymarker électricien' | sed -E 's/^ *[0-9]+ +-?[0-9.]+ +//')"
printf '%s\n' "$off_hits" | grep -q 'gateau.md' && fail "by default the French copy must not be merged; got: $off_hits"
# the accent-aware word split stays without the French copy
rm -f "$fr"
[ "$(top 'quel est le numéro de l’électricien')" = "$src/elec.md" ] || fail "an accented question must still find the electrician note first by default; got: $(hits 'quel est le numéro de l’électricien' | head -3)"
[ "$(top 'electricien')" = "$src/elec.md" ] || fail "the same word without the accent also finds it"
echo "PASS: the French merge is off by default (no fts_fr.db built, an old one removed, a planted one never merged); the accent-aware word split still finds accented questions; NB_FR_INDEX=on turns the French index back on."
