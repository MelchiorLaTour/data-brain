#!/usr/bin/env bash
# compile-room.sh — Phase 3 GATHER step (Option A). Pure bash, Claude-OFF, no model/API.
# Bundles one room's notes (extract bodies + local md/txt bodies) into a prompt-ready
# moc/wiki/<room>/_BUNDLE.md, then STOPS. It writes NO wiki prose — the Claude-ON compile
# step (me, in-session, on request) reads the bundle and writes the OVERVIEW/concept pages.
# NO COPY of any source; the only write is NewBrain's own moc/wiki/<room>/_BUNDLE.md.
# Usage:  bin/compile-room.sh <room>
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INDEX="$ROOT/moc/index.tsv"
EXDIR="$ROOT/moc/extracted"
CAP=2000   # per-note body char cap, keeps a big room inside a sane prompt budget
[ -s "$INDEX" ] || { echo "error: $INDEX missing/empty" >&2; exit 1; }

ROOM="${1:-}"
[ -n "$ROOM" ] || { echo "usage: compile-room.sh <room>" >&2; exit 1; }

# 1. validate the room exists in some themes cell; else error + list rooms.
if ! awk -F'\t' -v r="$ROOM" '
      $1 !~ /^#/ { n=split($3,a,","); for(i=1;i<=n;i++) if(a[i]==r){found=1; exit} }
      END { exit !found }' "$INDEX"; then
  echo "error: room '$ROOM' not found in $INDEX" >&2
  echo "available rooms:" >&2
  awk -F'\t' '$1 !~ /^#/ { n=split($3,a,","); for(i=1;i<=n;i++) print a[i] }' "$INDEX" \
    | grep -vx '-' | sort | uniq -c | sort -rn | awk '{printf "  %-22s %s\n", $2, $1}' >&2
  exit 1
fi

# 2. make the room's wiki dir (NewBrain's own derived layer, free to write).
WIKIDIR="$ROOT/moc/wiki/$ROOM"
mkdir -p "$WIKIDIR"
BUNDLE="$WIKIDIR/_BUNDLE.md"

# staleness stamp — the room's signature (count + content hash of its index rows) AT COMPILE
# TIME, embedded in the bundle header. stale-wikis.sh (via lint.sh + brain-digest.sh) recomputes
# it later; a drift = the wiki was built from an older index and must be recompiled. Same helper
# computes both sides so they can never disagree. This is the anti-rot guard (a compiled wiki can
# NEVER silently rot: the next lint/session surfaces the drift).
STAMP="$("$ROOT/bin/room-stamp.sh" "$ROOM")"
SCOUNT="${STAMP%%$'\t'*}"; SHASH="${STAMP##*$'\t'}"

# resolve a note body via the 3-step rule: extract → local md/txt → title-only.
# echoes the body on stdout; returns 0 if a body was found, 1 if title-only.
resolve_body() {
  local path="$1" f h ex
  h="$(printf '%s' "$path" | shasum | cut -c1-16)"
  ex="$EXDIR/$h.txt"
  if [ -s "$ex" ]; then                                  # step 1: derived extract
    grep -v '^<!-- newbrain-extract source:' "$ex" | sed '/./,$!d'
    return 0
  fi
  f="${path/#\~/$HOME}"                                  # step 2: local md/txt body
  case "$f" in *.md|*.markdown|*.txt) ;; *) return 1 ;; esac
  if [ -f "$f" ] && [ -r "$f" ] && ! ls -lO "$f" 2>/dev/null | grep -q 'dataless'; then
    cat "$f"; return 0
  fi
  return 1                                               # step 3: no body available
}

# 3. walk the index; bundle every row whose themes (comma-split) contains <room>.
total=0; titleonly=0
{
  printf '<!-- machine-written by compile-room.sh (GATHER step), regenerable — do not hand-edit; edit sources + recompile -->\n'
  printf '<!-- newbrain-stamp room=%s count=%s hash=%s date=%s -->\n' "$ROOM" "$SCOUNT" "$SHASH" "$(date '+%Y-%m-%d')"
  printf '# Bundle: %s room\n_generated %s — %s_\n\n' "$ROOM" "$(date '+%Y-%m-%d %H:%M')" "source: moc/index.tsv"
} > "$BUNDLE"

while IFS=$'\t' read -r canon title themes kw; do
  [ -n "${canon:-}" ] || continue
  case "$canon" in \#*) continue ;; esac
  case ",${themes:--}," in *,"$ROOM",*) ;; *) continue ;; esac   # comma-split membership
  total=$((total+1))
  body="$(resolve_body "$canon")" && hasbody=1 || hasbody=0

  printf '## %s\n_path: %s_\n\n' "${title:-(untitled)}" "$canon" >> "$BUNDLE"
  if [ "$hasbody" -eq 1 ]; then
    capped="$(printf '%s' "$body" | cut -c1-"$CAP")"
    printf '%s\n' "$capped" >> "$BUNDLE"
    [ "$capped" != "$body" ] && printf '\n_[...truncated at %s chars]_\n' "$CAP" >> "$BUNDLE"
  else
    printf '_(title-only — no body available: offloaded original or OCR failure)_\n' >> "$BUNDLE"
    titleonly=$((titleonly+1))
  fi
  printf '\n---\n\n' >> "$BUNDLE"
done < "$INDEX"

# 4 + 5. report and STOP. No wiki prose is written here.
rel="${BUNDLE/#$HOME/~}"
echo "bundle ready: $rel ($total notes, $titleonly title-only)."
echo "Now ask Claude to compile it into wiki pages (OVERVIEW.md + concept pages)."
