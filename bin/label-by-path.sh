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
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/moc/index.tsv"
[ -s "$INDEX" ] || { echo "error: $INDEX missing/empty" >&2; exit 1; }

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
