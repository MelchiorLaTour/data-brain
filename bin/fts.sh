#!/usr/bin/env bash
# fts.sh — BM25-ranked, OR-by-default query over the FTS5 index (moc/fts.db). Works with Claude OFF.
# The label-aware complement to search.sh: where search.sh matches a query as ONE regex phrase over
# note bodies (so a natural-language paraphrase misses), fts.sh splits the query into content words,
# ORs them, and ranks every note by BM25 over its title + themes + keywords + body. A note surfaces
# if it shares ANY meaningful word with the query; the best-matching notes float to the top.
#
# Usage: fts.sh "natural language query" [limit]     (limit defaults to 20)
# Build/refresh the index with build-fts.sh first.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# DB defaults to the live index; NB_FTS_DB overrides it for scratch A/B measurement (env unset =
# live behavior, so this is transparent to every normal caller).
DB="${NB_FTS_DB:-$ROOT/moc/fts.db}"
[ -f "$DB" ] || { echo "fts: no index — run build-fts.sh first ($DB missing)" >&2; exit 1; }
# Stale-index warning: index.tsv is the label source of truth; if it changed after fts.db was
# built, the ranked results may miss or mislabel recent notes. Warning only — never blocks.
[ "$ROOT/moc/index.tsv" -nt "$DB" ] && echo "⚠ fts index STALE: moc/index.tsv is newer than fts.db — run: bash bin/build-fts.sh" >&2

# Trailing numeric arg = result limit; the rest is the query.
LIMIT=20
if [ "$#" -ge 2 ] && [[ "${!#}" =~ ^[0-9]+$ ]]; then LIMIT="${!#}"; set -- "${@:1:$#-1}"; fi
Q="${*:-}"
[ -n "$Q" ] || { echo "usage: fts.sh \"query\" [limit]" >&2; exit 1; }

# Query rewrite: lowercase, non-alphanumeric -> space, drop a small stopword set and 1-char tokens,
# wrap each survivor as an FTS5 string term and OR them. BM25's IDF down-weights common words, so
# rare content words dominate the ranking on their own.
STOP=" the a an my me i of to in on for and or is it that this at as be by with from about our we you your his her their they them then than so if but not no yes do does did have has had will would can could should im ive "
match=""
terms=()
for w in $(printf '%s' "$Q" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' ' '); do
  [ "${#w}" -ge 2 ] || continue
  case "$STOP" in *" $w "*) continue;; esac
  terms+=("$w")
  match+="\"$w\" OR "
done
# Full content-word count BEFORE the year-drop — the weak-match coverage denominator (D3,
# 2026-07-06): a dropped year still COUNTS against coverage so a year-trap ("resume 2024") is judged
# on all its content words, not just the survivors, and regains its honesty flag. Years are kept OUT of
# the numerator (they match every dated note) but IN the denominator here.
nterms_full="${#terms[@]}"
# Bare-year query-drop (generic doctrine, 2026-07-05): a 4-digit year (1900-2099) alongside other
# content words matches every note whose BODY mentions it (resumes, tax docs, dated exports) and
# drowns the real subject. Drop bare years from the MATCH terms when other content words exist;
# a year-only query keeps them (the year IS the subject then). Same rule extract.sh and
# backfill-keywords.sh already apply keyword-side; this closes the body-text side at query time.
if [ "${#terms[@]}" -ge 2 ]; then
  nonyear=()
  for w in "${terms[@]}"; do
    case "$w" in 19[0-9][0-9]|20[0-9][0-9]) ;; *) nonyear+=("$w");; esac
  done
  if [ "${#nonyear[@]}" -ge 1 ] && [ "${#nonyear[@]}" -lt "${#terms[@]}" ]; then
    terms=("${nonyear[@]}")
    match=""
    for w in "${terms[@]}"; do match+="\"$w\" OR "; done
  fi
fi
match="${match% OR }"
[ -n "$match" ] || { echo "no content words in: $Q" >&2; exit 0; }

# bm25() is negative (more negative = better); ORDER BY it ascending = best first. It's an FTS
# auxiliary function usable only in the MATCH query itself (not inside a window fn), so rank the
# top-N in an inner query, then number them in the outer. path is already stored in ~ form.
#
# Default BM25 (equal column weights). NOTE (2026-07-06, search-fix Session 16): a column-weighted
# variant bm25(notes,0.0,10.0,2.0,6.0,1.0) was tried (title×10/keywords×6) to fix H9/H10 sibling-
# crowding + surface container-type tokens, but the blind gate showed 0 bar improvement AND a trap-
# honesty regression (purpose-word junk queries stopped weak-flagging). REVERTED here to default.
BM25='bm25(notes)'
out="$(sqlite3 "$DB" "SELECT printf('%2d  %8.2f  %s', ROW_NUMBER() OVER (ORDER BY score), score, path) FROM (SELECT $BM25 AS score, path FROM notes WHERE notes MATCH '$match' ORDER BY $BM25 LIMIT $LIMIT);" 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then echo "fts error: $out" >&2; exit 1; fi
if [ -z "$out" ]; then
  echo "no matches for: $Q"
else
  printf '%s\n' "$out"
  # Weak-match annotation (trap honesty, Q5): absolute BM25 does NOT separate real hits from junk
  # (measured 2026-07-05 on the author's corpus: a junk query's top score beat a real hit's score),
  # so the mechanical basis is TERM COVERAGE — how many of the query's content words the top hit
  # matches at all. A multi-word query whose best note matches at most HALF the words is a weak
  # match: the honest answer is "not in the brain". Single-word queries are exempt (any hit on a
  # rare word is genuine; total absence already prints "no matches").
  if [ "$nterms_full" -ge 2 ]; then
    top="$(printf '%s\n' "$out" | head -1 | sed -E 's/^ *[0-9]+ +[-0-9.]+ +//')"
    # Compare paths in bash (grep -Fx), not in SQL — paths with apostrophes break SQL
    # string-literal quoting (measured: every probe on such a path returned 0).
    # NOTE (Session 16, 2026-07-06): this coverage flag is a WEAK ADVISORY, not a trap-honesty
    # guarantee. Blind gates proved no cheap mechanical signal (count-coverage, IDF-coverage,
    # BM25 score, cosine) separates plausible red-team traps from real hits on this corpus, and the
    # probe only inspects rank-1 so a real hit whose target sits at rank 2/3 can false-flag. Real
    # trap honesty lives in the BEHAVIORAL layer (brain-first doctrine: read the top hits, judge
    # whether they answer, say "not in the brain" when they don't). Do not treat this line as proof.
    m=0
    for w in "${terms[@]}"; do
      # grep -Fx (NOT -q) so it reads sqlite's output to EOF. With `set -o pipefail`, a `grep -q`
      # early-exit closes the pipe mid-write on a large result set (e.g. "plan" = 483 rows) → sqlite3
      # takes SIGPIPE → pipefail fails the pipeline → the term is silently uncounted → a real hit gets
      # falsely WEAK-flagged. Reading to EOF (output to /dev/null) avoids the SIGPIPE race. (Bug found
      # 2026-07-06; the original probe was only verified on small-result-set terms.)
      if sqlite3 "$DB" "SELECT path FROM notes WHERE notes MATCH '\"$w\"';" 2>/dev/null | grep -Fx -- "$top" >/dev/null; then
        m=$((m+1))
      fi
    done
    if [ $((m * 2)) -le "$nterms_full" ]; then
      printf '⚠ WEAK MATCH: top hit matches only %d/%d query words — treat as likely NOT in the brain\n' "$m" "$nterms_full"
    fi
  fi
fi
