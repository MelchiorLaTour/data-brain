#!/usr/bin/env bash
# rebuild.sh — regenerate the human-navigable MOCs (moc/INDEX.md + moc/rooms/*.md) FROM the side
# index (moc/index.tsv). The side index is the LABEL SOURCE OF TRUTH (Option B, 2026-06-20): notes
# carry no theme line; index.tsv does. A note lands in a room because index.tsv says so.
#   - MULTI-LABEL is intended: a row with `themes = family,ideas,people` lists under ALL THREE rooms.
#     (The old "smear" framing is retired — multi-membership is by-design as of 2026-06-20.)
#   - NewBrain stores NO content: every entry links to the note's CANONICAL home.
#   - rebuild READS index.tsv and is SAFE to re-run; it NEVER writes index.tsv (that's build-index.sh
#     / file-note.sh's job). Delete moc/INDEX.md + moc/rooms and rerun to regenerate. Claude-OFF safe.
# bash 3.2 (macOS default) — no associative arrays.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOC="$ROOT/moc"
INDEX="$MOC/index.tsv"
ROOMS="$MOC/rooms"
TS="$(date '+%Y-%m-%d %H:%M')"

if [ ! -s "$INDEX" ]; then
  echo "error: $INDEX missing or empty. Run bin/build-index.sh first." >&2
  exit 1
fi

# Wipe only the DERIVED outputs; never the source index.
rm -rf "$ROOMS" "$MOC/INDEX.md"
mkdir -p "$ROOMS"

BUCKETS="$(mktemp -d)"; trap 'rm -rf "$BUCKETS"' EXIT

total=0; labeled=0; unlabeled=0
# Read the side index (skip the header line).
while IFS=$'\t' read -r canon title themes keywords; do
  [ -n "${canon:-}" ] || continue
  case "$canon" in \#*) continue ;; esac   # header / comments
  total=$((total + 1))
  if [ -z "${themes:-}" ] || [ "$themes" = "-" ]; then
    unlabeled=$((unlabeled + 1))
    printf '%s\t%s\n' "$title" "$canon" >> "$BUCKETS/__unlabeled__"
    continue
  fi
  labeled=$((labeled + 1))
  IFS=',' read -ra arr <<< "$themes"
  for r in "${arr[@]}"; do
    r="$(echo "$r" | tr -d '[:space:]')"
    [ -n "$r" ] || continue
    printf '%s\t%s\n' "$title" "$canon" >> "$BUCKETS/$r"
  done
done < "$INDEX"

# Render one MOC per room bucket; echo the unique note count.
write_room () {  # $1 = bucket file, $2 = display name, $3 = outfile
  local bucket="$1" name="$2" out="$3" n
  [ -s "$bucket" ] || { echo 0; return; }
  n="$(sort -u "$bucket" | grep -c . || true)"
  {
    echo "# Room — $name"
    echo ""
    echo "_${n} notes. Drawn from \`moc/index.tsv\` (the label source of truth). Generated $TS — do not hand-edit; edit index.tsv + rerun rebuild.sh._"
    echo ""
    sort -u "$bucket" | while IFS=$'\t' read -r t c; do
      [ -n "$t" ] && echo "- [$t]($c)"
    done
  } > "$out"
  echo "$n"
}

{
  echo "# NewBrain — Rooms (Maps of Content)"
  echo ""
  echo "_Generated $TS by bin/rebuild.sh. DERIVED + rebuildable from \`moc/index.tsv\` — do not hand-edit._"
  echo "_Every entry links to the note's CANONICAL home; NewBrain stores no copies._"
  echo "_Labels live in index.tsv (notes carry none). Multi-label is intended: a note can list in several rooms._"
  echo ""
  echo "## Rooms"
} > "$MOC/INDEX.md"

# Stable room order (optional): space-separated room names to pin first in INDEX.md;
# every other room follows alphabetically. Leave empty for pure alphabetical.
ORDER=""
for r in $ORDER; do
  [ -s "$BUCKETS/$r" ] || continue
  count="$(write_room "$BUCKETS/$r" "$r" "$ROOMS/$r.md")"
  echo "- [$r](rooms/$r.md) — $count notes" >> "$MOC/INDEX.md"
done
for b in "$BUCKETS"/*; do
  r="$(basename "$b")"
  [ "$r" = "__unlabeled__" ] && continue
  case " $ORDER " in *" $r "*) continue ;; esac
  count="$(write_room "$b" "$r" "$ROOMS/$r.md")"
  echo "- [$r](rooms/$r.md) — $count notes" >> "$MOC/INDEX.md"
done

if [ -s "$BUCKETS/__unlabeled__" ]; then
  ucount="$(write_room "$BUCKETS/__unlabeled__" "unlabeled (no theme yet)" "$ROOMS/_unlabeled.md")"
  {
    echo ""
    echo "## Fallback"
    echo "- [_unlabeled_](rooms/_unlabeled.md) — $ucount notes with no theme in index.tsv"
    echo "- [index.tsv](index.tsv) — the label source of truth; full-coverage list of all $total notes"
  } >> "$MOC/INDEX.md"
fi

echo "rebuilt: $total notes ($labeled labeled, $unlabeled unlabeled) from $INDEX -> $MOC/INDEX.md + $ROOMS/"
