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
#         bin/ingest-root.sh "/absolute/root" --paths FILE   # only the files listed in FILE (absolute, one per line), no walk of the folder.
#                                                            # Same rules as the walk: type, prune list, approved source, cloud, privacy.
#   The root must ALSO be added to canon.sh CANON[] so search.sh's full-text rg covers it.
#   After ingest + canon.sh edit, rerun bin/rebuild.sh to redraw the room MOCs.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT/bin/canon.sh"
MOC="${NB_MOC_DIR:-$ROOT/moc}"
INDEX="$MOC/index.tsv"

SRC="${1:-}"; LISTED=""
if [ "${2:-}" = "--paths" ]; then LISTED="${3:-}"; [ -f "$LISTED" ] || { echo "ingest-root: --paths file not found" >&2; exit 1; }; fi
[ -n "$SRC" ] && [ -d "$SRC" ] || { echo "usage: ingest-root.sh <existing-dir> [--paths FILE]" >&2; exit 1; }
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
if [ -n "$LISTED" ]; then
  # Listed files only: each must sit inside this root, be a regular file that is not a link, and pass is_approved_source_path; then the
  # very same type and prune filters as the walk run on it, with paths relative to the root exactly as the walk sees them.
  root_identity="$(approved_root_identity "$SRC")" || { echo 'ingest-root: the selected folder is not approved' >&2; exit 2; }
  rels=()
  while IFS= read -r p || [ -n "$p" ]; do
    case "$p" in "$SRC"/*) ;; *) continue ;; esac
    case "$p" in *$'\n'*|*$'\r'*|*$'\t'*) continue ;; esac
    [ -f "$p" ] && [ ! -L "$p" ] && is_approved_source_path "$p" || continue
    nb_in_brain_moc "$p" && continue
    rels+=("./${p#"$SRC"/}")
  done < "$LISTED"
  : > "$relative"
  if [ "${#rels[@]}" -gt 0 ]; then
    ( cd "$SRC" 2>/dev/null && [ "$(stat -f '%d:%i' . 2>/dev/null)" = "$root_identity" ] || exit 2
      find "${rels[@]}" -type f \( \
           -iname '*.md' -o -iname '*.txt' -o -iname '*.pdf' \
        -o -iname '*.docx' -o -iname '*.doc' -o -iname '*.pages' -o -iname '*.rtf' \) \
        "${PRUNE_FIND[@]}" -print0 | while IFS= read -r -d '' entry; do printf '%s/%s\0' "$SRC" "${entry#./}"; done
    ) > "$relative" || { echo 'ingest-root: selected folder changed identity; no new rows were written' >&2; exit 2; }
  fi
else
selected_root_find0 "$SRC" "${PRUNE_DIRS[@]}" -type f \( \
     -iname '*.md' -o -iname '*.txt' -o -iname '*.pdf' \
  -o -iname '*.docx' -o -iname '*.doc' -o -iname '*.pages' -o -iname '*.rtf' \) \
  "${PRUNE_FIND[@]}" > "$relative" || { echo 'ingest-root: selected folder changed identity during traversal; no new rows were written' >&2; exit 2; }
fi
while IFS= read -r -d '' f; do printf '%s\n' "$f"; done < "$relative" | sort > "$found"

# New files only: online-only cloud files are left for databrain_cloud_fetch (reading them would download them), then the privacy
# screen (names, then text of md/txt). Dropped files never become rows.
dropped="$tmpd/dropped"; : > "$dropped"
comm -23 "$found" "$existing" > "$tmpd/candidates"
nb_dataless_paths < "$tmpd/candidates" | sort > "$tmpd/cloud"
if [ -s "$tmpd/cloud" ]; then comm -23 "$tmpd/candidates" "$tmpd/cloud" > "$tmpd/local"; else cp "$tmpd/candidates" "$tmpd/local"; fi
if [ -n "${NB_PRIVACY_FILE:-}" ]; then
  /usr/bin/perl "$ROOT/bin/privacy.pl" filter < "$tmpd/local" > "$tmpd/kept" || { echo 'ingest-root: privacy screen failed' >&2; exit 2; }
else
  cp "$tmpd/local" "$tmpd/kept"
fi
comm -23 "$tmpd/candidates" "$tmpd/kept" > "$dropped"

added=0; skipped=0; unsafe=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if grep -qxF "$f" "$existing"; then skipped=$((skipped + 1)); continue; fi
  if [ -s "$dropped" ] && grep -qxF "$f" "$dropped"; then continue; fi
  base="$(basename "$f")"
  ext="${base##*.}"; ext_lower="$(printf '%s' "$ext" | tr '[:upper:]' '[:lower:]')"   # ext keeps its real case: the title strips the real suffix
  title="$(basename "$f" ".$ext" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2} //')"
  canon="${f/#$HOME/~}"
  kw='-'
  if [ "$ext_lower" = "md" ]; then
    # A Markdown file this Mac will not let us read (permission, or gone since the walk) is left out, not fatal: the inventory reports
    # it as unreadable. Only a file that changes identity while being read still stops the commit.
    [ -r "$f" ] || continue
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
