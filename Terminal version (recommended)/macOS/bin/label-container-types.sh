#!/usr/bin/env bash
# label-container-types.sh — generic TYPE/PURPOSE labeling for "container/list" documents
# (2026-07-06, search-fix Session 15+). Design insight: a container doc — a recipe, a
# workout plan, a packing list — should be retrieved by its KIND + PURPOSE ("my recipes",
# "workout plan"), NOT by matching a line item inside it (an ingredient, an exercise name).
# That is the LABEL layer's job. This pass appends clean purpose tokens (EN+FR) to the
# keywords column of every detected container so a general query reaches the whole doc.
#
# GENERIC, never query-targeted: detection is driven by two author-provided signals only —
#   (A) the note's `type:` frontmatter (type: list / wishlist / todo / contacts / ledger / plan)
#   (B) container-kind words IN THE TITLE (recipe, workout plan, packing list, playlist, ...)
# with fitness/false-friend guards so "AT&T first-day training" is NOT read as a workout.
# It NEVER clobbers or removes an existing keyword; it only APPENDS tokens not already present.
# Rows with themes/keywords untouched otherwise. index.tsv only — no source file is ever moved,
# renamed, or written. Pure bash/awk, Claude-OFF, idempotent, re-runnable.
#
# Usage:
#   bin/label-container-types.sh --dry     # preview: print every row it WOULD change, no write
#   bin/label-container-types.sh           # apply (backup index.tsv first — caller's job)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/moc/index.tsv"
[ -s "$INDEX" ] || { echo "error: $INDEX missing/empty" >&2; exit 1; }
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1

# ---- Pre-pass: build a path -> type-frontmatter map for LOCAL md/txt notes only ----
# (`grep -m1 '^type:'` — cheap; skip iCloud-dataless files so no download is forced.)
tmpd="$(mktemp -d)"; trap 'rm -rf "$tmpd"' EXIT
TYPEMAP="$tmpd/typemap"; : > "$TYPEMAP"
while IFS=$'\t' read -r path title themes keywords; do
  case "$path" in \#*|"") continue ;; esac
  f="${path/#\~/$HOME}"
  ext="$(printf '%s' "${f##*.}" | tr 'A-Z' 'a-z')"
  case "$ext" in md|markdown|txt) ;; *) continue ;; esac
  [ -e "$f" ] || continue
  ls -lO "$f" 2>/dev/null | grep -q 'dataless' && continue
  tv="$(grep -m1 -iE '^type:[[:space:]]*' "$f" 2>/dev/null | sed -E 's/^[Tt][Yy][Pp][Ee]:[[:space:]]*//' | tr 'A-Z' 'a-z' | tr -d '\r')"
  [ -n "$tv" ] && printf '%s\t%s\n' "$path" "$tv" >> "$TYPEMAP"
done < "$INDEX"

# ---- Main pass: detect container kind from (type-field + title), append purpose tokens ----
out="$(awk -F'\t' -v OFS='\t' -v typemap="$TYPEMAP" -v dry="$DRY" '
BEGIN {
  while ((getline line < typemap) > 0) { split(line, a, "\t"); tmap[a[1]] = a[2] }
  close(typemap)
}
# Append the comma-list of tokens in `bundle` to global buffer `ADD`, skipping dups.
function emit(bundle,   n, arr, i, t) {
  n = split(bundle, arr, ",")
  for (i = 1; i <= n; i++) { t = arr[i]; if (t != "" && !(t in have) && !(t in added)) { added[t]=1; ADD = ADD (ADD==""?"":",") t } }
}
NR==1 { if (!dry) print; next }
$1 ~ /^#/ { if (!dry) print; next }
{
  ttl = tolower($2)
  tv  = ($1 in tmap) ? tmap[$1] : ""
  # existing keywords -> have[] set (case-insensitive dedup target)
  delete have; delete added; ADD=""
  m = split($4, cur, ",")
  for (i=1;i<=m;i++) { c=tolower(cur[i]); if (c!="" && c!="-") have[c]=1 }

  # ---------- Signal A: type: frontmatter ----------
  if (tv ~ /^(list|wishlist|todo|contacts|ledger|inventory)$/) emit("list,liste")
  if (tv == "wishlist")  emit("wishlist,souhaits")
  if (tv == "todo")      emit("todo,tasks,taches")
  if (tv == "contacts")  emit("contacts,annuaire,directory")
  if (tv == "ledger")    emit("ledger,registre,budget")
  if (tv == "plan")      emit("plan")
  if (tv == "poetry")    { }   # not a container; explicit no-op for clarity

  # ---------- Signal B: container-kind words in the TITLE ----------
  # recipe / cooking
  if (ttl ~ /recipe|recette/) emit("recipe,recette,cooking,cuisine,dish,plat")
  # workout PLAN / routine (fitness-context guarded; excludes at&t/compliance "training",
  # and excludes pure stat/PR logs which are about-notes, not exercise-list containers)
  if (ttl ~ /workout|musculation|entrainement|plyometric|(strength|jump|weight).?(workout|training)|[0-9].?day.?split|bro.?split|\bppl\b|push.?pull.?legs/ \
      && ttl !~ /stats|pr goals|pr-goals|records/) \
    emit("workout,plan,programme,entrainement,musculation,seance,routine,gym,fitness,exercise,exercice")
  # packing list
  if (ttl ~ /packing.?list|liste.?(de.?)?bagage/) emit("packing-list,packing,bagages,voyage,travel")
  # shopping / grocery list
  if (ttl ~ /shopping.?list|grocer|liste.?(de.?)?course/) emit("shopping-list,grocery,groceries,courses,liste")
  # reading list / book list / reading tracker
  if (ttl ~ /reading.?(list|tracker)|book.?list|books?.?to.?read|livres?.?a.?lire/) emit("reading-list,books,livres,lecture,list,liste")
  # playlist / streaming lists
  if (ttl ~ /playlist|streaming.?sites?|movies?.?to.?watch|to.?watch/) emit("playlist,watchlist,list,liste")
  # itinerary
  if (ttl ~ /itinerary|itineraire/) emit("itinerary,itineraire,voyage,travel,trip")
  # budget / expenses
  if (ttl ~ /\bbudget\b|expense|depense/) emit("budget,expenses,depenses,finances")
  # meal plan / menu
  if (ttl ~ /meal.?plan|\bmenu\b|weekly.?menu/) emit("meal-plan,menu,repas,meals")
  # schedule / timetable
  if (ttl ~ /schedule|timetable|emploi.?du.?temps|horaire/ && ttl !~ /scheduled/) emit("schedule,timetable,horaire,planning")
  # checklist
  if (ttl ~ /checklist/) emit("checklist,list,liste,verification")
  # bucket list / goals list
  if (ttl ~ /bucket.?list/) emit("bucket-list,goals,objectifs,list,liste")
  # tier list / ranking list
  if (ttl ~ /tier.?list/) emit("tier-list,ranking,classement,list,liste")
  # inventory
  if (ttl ~ /inventory|inventaire/) emit("inventory,inventaire,list,liste")
  # gift list / gift ideas
  if (ttl ~ /gift.?(list|idea)|liste.?cadeau|cadeaux|christmas.?list/) emit("gift-list,gifts,cadeaux,list,liste")
  # wishlist (title)
  if (ttl ~ /wish.?list|wishlist/) emit("wishlist,souhaits,list,liste")
  # contact list / directory
  if (ttl ~ /contact.?(list|directory)|annuaire|directory/) emit("contacts,annuaire,directory,list,liste")

  if (ADD != "") {
    newkw = ($4=="-"||$4=="") ? ADD : $4","ADD
    if (dry) { print "WOULD LABEL:  "$2"  [type="tv"]" ; print "   + "ADD ; print "   = "newkw ; changed++ ; next }
    $4 = newkw ; changed++
  }
  if (!dry) print
}
END { if (dry) print "\n-- "changed" rows would be labeled --" > "/dev/stderr" ; else print "labeled "changed" rows" > "/dev/stderr" }
' "$INDEX")"

if [ "$DRY" = "1" ]; then
  printf '%s\n' "$out"
else
  printf '%s\n' "$out" > "$INDEX.new" && mv "$INDEX.new" "$INDEX"
  echo "next: bin/rebuild.sh && bin/build-fts.sh && bin/lint.sh"
fi
