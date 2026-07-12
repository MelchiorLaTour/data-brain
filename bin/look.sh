#!/usr/bin/env bash
# look.sh — read-less-first search: fts.sh (Tier 1) + the cheap extract tier (Tier 2) in one call.
# The point of the graft: the tiered ladder already EXISTS (index.tsv scan -> fts.sh BM25 ->
# moc/extracted/<hash>.txt sidecar -> full note), but reaching the sidecar tier meant hashing the
# path by hand and cat-ing the right file — a manual ritual, so it never happened and the habit was
# "open the whole note". look.sh makes the cheap tier the path of least resistance: it runs fts.sh,
# then for the top-k hits prints a capped snippet resolved by the SAME 3-step rule compile-room.sh
# uses. Judge relevance from the snippet; open the full note (Tier 3) only to quote/confirm.
#
# Does NOT touch fts.sh internals — it wraps it. The ⚠ WEAK MATCH advisory is passed straight through.
# Claude-OFF: pure bash, no model/API/network (shasum + cat + the fts.sh engine).
#
# Usage: look.sh "natural language query" [k]     (k = how many top hits to show bodies for; default 3)
#        LOOK_CAP=N look.sh "..."                  (per-hit snippet char cap; default 1200)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FTS="$ROOT/bin/fts.sh"
EXDIR="$ROOT/moc/extracted"
CAP="${LOOK_CAP:-1200}"   # per-hit snippet cap — enough to JUDGE a hit, not read the whole note

K=3
if [ "$#" -ge 2 ] && [[ "${!#}" =~ ^[0-9]+$ ]]; then K="${!#}"; set -- "${@:1:$#-1}"; fi
Q="${*:-}"
[ -n "$Q" ] || { echo "usage: look.sh \"query\" [k]" >&2; exit 1; }

# resolve a note body via the SAME 3-step rule as compile-room.sh: extract -> local md/txt -> none.
# echoes the body on stdout; returns 0 if a body was found, 1 if title-only.
resolve_body() {
  local path="$1" f h ex
  h="$(printf '%s' "$path" | shasum | cut -c1-16)"
  ex="$EXDIR/$h.txt"
  if [ -s "$ex" ]; then                                  # step 1: derived extract (the cheap tier)
    grep -v '^<!-- newbrain-extract source:' "$ex" | sed '/./,$!d'
    return 0
  fi
  f="${path/#\~/$HOME}"                                  # step 2: local md/txt body
  case "$f" in *.md|*.markdown|*.txt) ;; *) return 1 ;; esac
  if [ -f "$f" ] && [ -r "$f" ] && ! ls -lO "$f" 2>/dev/null | grep -q 'dataless'; then
    cat "$f"; return 0
  fi
  return 1                                               # step 3: no body available (offloaded/OCR-fail)
}

# Tier 1: run the engine. Keep its full output (ranked hits + any ⚠ WEAK MATCH line).
fts_out="$(bash "$FTS" "$Q" "$K" 2>/dev/null)"
if [ -z "$fts_out" ] || printf '%s' "$fts_out" | grep -q '^no matches'; then
  printf 'no matches for: %s\n' "$Q"
  exit 0
fi

# Tier 2: for each ranked hit line ("  1   -12.96  ~/path"), print the cheap snippet.
printf '%s\n' "$fts_out" | while IFS= read -r line; do
  case "$line" in
    [[:space:]]*[0-9]*[-0-9.]*[[:space:]]*'~'*)   # a ranked result line
      path="$(printf '%s' "$line" | sed -E 's/^ *[0-9]+ +[-0-9.]+ +//')"
      printf '\n%s\n' "$line"
      if body="$(resolve_body "$path")"; then
        snip="$(printf '%s' "$body" | cut -c1-"$CAP")"
        printf '    %s\n' "$(printf '%s' "$snip" | sed 's/^/    /' | head -40)"
        [ "$snip" != "$body" ] && printf '    _[...snippet capped at %s chars — open the note to read more]_\n' "$CAP"
      else
        printf '    _(title-only — offloaded original or OCR failure; open the note or run extract.sh)_\n'
      fi
      ;;
    *)   # non-result lines (the ⚠ WEAK MATCH advisory, warnings) — pass through verbatim
      printf '%s\n' "$line"
      ;;
  esac
done
exit 0   # the read-loop returns 1 at EOF; the script itself succeeded
