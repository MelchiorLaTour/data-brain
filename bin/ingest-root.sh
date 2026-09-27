#!/usr/bin/env bash
# ingest-root.sh — APPEND a new canonical root's note-like files into moc/index.tsv (Option B).
# This is the whole-laptop extension tool (STEP 7). It NEVER overwrites index.tsv and NEVER
# re-reads stripped frontmatter the way the one-time build-index.sh seeder did — it only APPENDS
# rows for files not already indexed. Foreign files arrive UNLABELED (themes='-'); label them
# later by editing index.tsv. Non-markdown files (pdf/docx/txt) get a title-only pointer row —
# which is exactly why the side index exists: a PDF can't hold a `theme:` frontmatter line.
#
# NO COPIES, NEVER MOVE/RENAME: this only reads file paths + (for .md) tags; it writes ONLY to
# index.tsv (NewBrain's own file). The real files are untouched.
#
# Usage:  bin/ingest-root.sh "/absolute/root"
#   The root must ALSO be added to canon.sh CANON[] so search.sh's full-text rg covers it.
#   After ingest + canon.sh edit, rerun bin/rebuild.sh to redraw the room MOCs.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
MOC="${NB_MOC_DIR:-$ROOT/moc}"
INDEX="$MOC/index.tsv"

SRC="${1:-}"
[ -n "$SRC" ] && [ -d "$SRC" ] || { echo "usage: ingest-root.sh <existing-dir>" >&2; exit 1; }
[ -s "$INDEX" ] || { echo "error: $INDEX missing/empty (run build-index.sh once first)" >&2; exit 1; }

# Machinery / app+game-data / Sensitive pruning lives in canon.sh (PRUNE_FIND), the single shared
# list — so search.sh, ingest, and rebuild can never disagree about what is in scope.
tmpd="$(mktemp -d "$MOC/.ingest-root.XXXXXX")"; trap 'rm -rf "$tmpd"' EXIT
existing="$tmpd/existing"; found="$tmpd/found"
relative="$tmpd/relative"; new_rows="$tmpd/new-rows.tsv"
: > "$new_rows"

# Existing indexed paths (col1), expanded ~ -> $HOME, for dedup.
cut -f1 "$INDEX" | sed "s#^~#$HOME#" | sort -u > "$existing"

# Note-like file types only. Images are intentionally EXCLUDED here (a screenshot is not a note;
# add image ingest deliberately if you want it). Forbidden directories are pruned before traversal
# by canon.sh PRUNE_DIRS; PRUNE_FIND applies the remaining file/path exclusions.
selected_root_find0 "$SRC" "${PRUNE_DIRS[@]}" -type f \( \
     -name '*.md' -o -name '*.txt' -o -name '*.pdf' \
  -o -name '*.docx' -o -name '*.doc' -o -name '*.pages' -o -name '*.rtf' \) \
  "${PRUNE_FIND[@]}" > "$relative" || { echo 'ingest-root: selected folder changed identity during traversal; no new rows were written' >&2; exit 2; }
while IFS= read -r -d '' f; do printf '%s\n' "$f"; done < "$relative" | sort > "$found"

added=0; skipped=0; unsafe=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if grep -qxF "$f" "$existing"; then skipped=$((skipped + 1)); continue; fi
  base="$(basename "$f")"
  ext="${base##*.}"
  title="$(basename "$f" ".$ext" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2} //')"
  canon="${f/#$HOME/~}"
  kw='-'
  if [ "$ext" = "md" ]; then
    fm="$(read_approved_frontmatter "$f")" || {
      echo 'ingest-root: a source changed before its frontmatter could be read; no new rows were committed' >&2
      unsafe=$((unsafe + 1))
      continue
    }
    k="$(printf '%s\n' "$fm" | sed -n 's/^tags:[[:space:]]*\[\(.*\)\].*$/\1/p' | head -1 \
          | tr ',' '\n' | sed -E 's/^[[:space:]]+//;s/[[:space:]]+$//' \
          | grep -viE '^(user)$' | grep -vE '^[0-9]{4}$' | paste -sd, -)"
    [ -n "$k" ] && kw="$k"
  fi
  printf '%s\t%s\t%s\t%s\n' "$canon" "$title" "-" "$kw" >> "$new_rows"
  added=$((added + 1))
done < "$found"

if [ "$unsafe" -gt 0 ]; then exit 2; fi
if [ -s "$new_rows" ]; then
  staged_index="$tmpd/index.tsv"
  cp -p "$INDEX" "$staged_index" || { echo 'ingest-root: could not stage the existing index' >&2; exit 2; }
  cat "$new_rows" >> "$staged_index" || { echo 'ingest-root: could not stage new index rows' >&2; exit 2; }
  mv -f -- "$staged_index" "$INDEX" || { echo 'ingest-root: could not safely replace index.tsv' >&2; exit 2; }
fi

# P2 — append a one-line entry to the derived change ledger (moc/log.md). Append-only, never
# regenerated, so the "what was indexed when" trail survives rebuilds. `date` is a shell builtin
# (not a model call) -> Claude-OFF invariant holds.
if [ "$added" -gt 0 ]; then
  LOG="$MOC/log.md"
  [ -f "$LOG" ] || printf '# NewBrain — change log (ingest history)\n\n_Append-only, newest at the bottom. `grep "^## \\[" moc/log.md | tail -5` for the latest._\n\n' > "$LOG"
  printf '## [%s] ingest | %s (+%s rows)\n' "$(date '+%Y-%m-%d')" "${SRC/#$HOME/~}" "$added" >> "$LOG"
fi

echo "ingested $SRC: +$added new rows, $skipped already-indexed. index.tsv now $(($(wc -l < "$INDEX") - 1)) notes."
echo "next: ensure \"$SRC\" is in canon.sh CANON[], then run bin/rebuild.sh"
