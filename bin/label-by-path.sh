#!/usr/bin/env bash
# label-by-path.sh — auto-label the UNLABELED rows in moc/index.tsv by deriving a room from each
# note's canonical PATH. The folder a note lives in is a strong theme signal (Desktop/School -> school,
# Desktop/Personal Records -> records, ~/Claude/<project> -> that project's room).
#
# SAFE: only rewrites rows whose themes column is '-' (unlabeled). Hand-seeded labels
# are NEVER touched. Re-runnable + idempotent: run it again after adding sources and it labels only
# the new unlabeled rows. To re-file, just edit the rule below + re-run (it won't clobber real labels...
# it only fills '-'). Writes index.tsv (NewBrain's OWN file — allowed; never touches a source note).
#
# The room a path maps to is the MAPPING below — edit it to rename/re-route, then re-run + rebuild.sh.
# EXAMPLE mapping — the INSTALL.md bootstrap proposes YOUR mapping from your real folders and
# confirms it with you before writing; the rows below just show the shape.
#
# SAFETY NET: unmatched paths return '-' (stay unlabeled), NOT a junk room. Because this script
# only ever fills '-' rows, a wrong default would be stamped permanently and your real mapping
# could never take effect. Keep the default '-' until your mapping is genuinely complete.
#
# --suggest [DEPTH]  drafts the mapping FOR you from your real folders and prints it for
#                    pasting. It writes nothing and labels nothing — you still decide the room
#                    names and the human still confirms. DEPTH (default 2) is how many path
#                    components make a room: depth 2 turns ~/Vault/Career/... into "career",
#                    depth 3 is what a vault shaped ~/Vault/Areas/Career needs.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/moc/index.tsv"
[ -s "$INDEX" ] || { echo "error: $INDEX missing/empty" >&2; exit 1; }

if [ "${1:-}" = "--suggest" ]; then
  DEPTH="${2:-2}"
  case "$DEPTH" in ''|*[!0-9]*) echo "usage: label-by-path.sh --suggest [DEPTH]" >&2; exit 1 ;; esac
  echo "# Draft mapping at depth $DEPTH — paste into the room() function in bin/label-by-path.sh,"
  echo "# above the final 'return \"-\"'. Rename the rooms to your life areas; delete what you"
  echo "# do not want labelled. Nothing has been written."
  echo ""
  awk -F'\t' -v depth="$DEPTH" '
    NR>1 && $1 !~ /^#/ {
      p = $1; sub(/^~\//, "", p)
      n = split(p, a, "/")
      if (n <= depth) next                      # a file sitting directly in a root: no folder
      key = ""; for (i = 1; i <= depth; i++) key = key "/" a[i]
      c[key]++; leaf[key] = a[depth]
    }
    END { for (k in c) printf "%d\t%s\t%s\n", c[k], k, leaf[k] }
  ' "$INDEX" | sort -t"$(printf '\t')" -k1,1nr | awk -F'\t' '
    {
      esc = $2
      gsub(/\./, "\\.", esc); gsub(/\(/, "\\(", esc)
      gsub(/\)/, "\\)", esc); gsub(/\+/, "\\+", esc)
      gsub(/\//, "\\/", esc)
      room = tolower($3); gsub(/[^a-z0-9]+/, "-", room); gsub(/^-+|-+$/, "", room)
      printf "  if (p ~ /%s\\//) return \"%s\"\t# %s notes\n", esc, room, $1
    }
  '
  echo ""
  echo "# Rooms too coarse (everything landing in one)? Re-run:  bash bin/label-by-path.sh --suggest $((DEPTH+1))"
  exit 0
fi

tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT

awk -F'\t' -v OFS='\t' '
function room(p,   lp) {
  lp = tolower(p)
  # --- EXAMPLE rows: folder → room. Replace with YOUR folders and room names. ---
  if (p ~ /\/Desktop\/School\//)            return "school"
  if (p ~ /\/Desktop\/Career\//)            return "career"
  if (p ~ /\/Desktop\/Writing\//)           return "writing"
  if (p ~ /\/Desktop\/Personal Records\//)  return "records"
  if (p ~ /\/Documents\/GitHub\//)          return "projects"
  # --- Downloads: split by filename keyword (deliverables of mixed kind) — example split ---
  if (p ~ /\/Downloads\//) {
    if (lp ~ /(resume|^cv |_cv|-cv)/)       return "career"
    if (lp ~ /(letter|motivation|cover)/)   return "writing"
    if (lp ~ /(passport|license|licence|diploma|transcript|degree|id_|_id)/) return "records"
    return "-"                              # unmatched Downloads stay unlabeled (see SAFETY NET above)
  }
  # --- anything else: stay unlabeled so a later, better mapping can still fill it ---
  return "-"
}
NR==1 { print; next }                       # keep header
$1 ~ /^#/ { print; next }
{
  if ($3 == "-" || $3 == "") $3 = room($1)
  print
}
' "$INDEX" > "$tmp"

mv "$tmp" "$INDEX"
echo "labeled. index.tsv now:"
awk -F'\t' 'NR>1 && $1!~/^#/ { if($3=="-"||$3=="") u++; else l++ } END { print "  labeled="l"  unlabeled="u }' "$INDEX"
