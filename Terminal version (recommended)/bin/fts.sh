#!/usr/bin/env bash
# fts.sh — BM25-ranked, OR-by-default query over the FTS5 index (moc/fts.db). Works with Claude OFF.
# The label-aware complement to search.sh: where search.sh matches a query as ONE regex phrase over
# note bodies (so a natural-language paraphrase misses), fts.sh splits the query into content words,
# ORs them, and ranks every note by BM25 over its title + themes + keywords + body. A note surfaces
# if it shares ANY meaningful word with the query; the best-matching notes float to the top.
#
# Usage: fts.sh "natural language query" [limit]     (limit defaults to 20)
# Paging for the MCP server (all unset = the plain list above): NB_FTS_OFFSET=N skips the first N ranked notes (the rank numbers keep counting
# from N+1); NB_FTS_COUNT=1 first prints "matches: T" (every note that matches, not only the page); NB_FTS_SNIPPET=1 prints under each hit one
# line "      excerpt: ..." with the words around the match in the body.
# Build/refresh the index with build-fts.sh first.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# DB defaults to the live index; NB_FTS_DB overrides it for scratch A/B measurement (env unset =
# live behavior, so this is transparent to every normal caller).
MOC="${NB_MOC_DIR:-$ROOT/moc}"
DB="${NB_FTS_DB:-$MOC/fts.db}"
[ -f "$DB" ] || { echo "fts: no index — run build-fts.sh first ($DB missing)" >&2; exit 1; }
# Stale-index warning: index.tsv is the label source of truth; if it changed after fts.db was
# built, the ranked results may miss or mislabel recent notes. Warning only — never blocks.
INDEX="${NB_FTS_INDEX:-$MOC/index.tsv}"
[ -f "$INDEX" ] && [ "$INDEX" -nt "$DB" ] && echo "⚠ fts index STALE: $INDEX is newer than $DB — run: bash bin/build-fts.sh" >&2

# Trailing numeric arg = result limit; the rest is the query.
LIMIT=20
if [ "$#" -ge 2 ] && [[ "${!#}" =~ ^[0-9]+$ ]]; then LIMIT="${!#}"; set -- "${@:1:$#-1}"; fi
Q="${*:-}"
OFFSET="${NB_FTS_OFFSET:-0}"; [[ "$OFFSET" =~ ^[0-9]+$ ]] || OFFSET=0
[ -n "$Q" ] || { echo "usage: fts.sh \"query\" [limit]" >&2; exit 1; }

# Query rewrite: lowercase, non-alphanumeric -> space, drop a small stopword set and 1-char tokens,
# wrap each survivor as an FTS5 string term and OR them. BM25's IDF down-weights common words, so
# rare content words dominate the ranking on their own.
# French function words are dropped too (they would match nearly every French note). Words that are also real English words or names
# (ma, son, ai, un, elle) are deliberately not in the list.
STOP=" the a an my me i of to in on for and or is it that this at as be by with from about our we you your his her their they them then than so if but not no yes do does did have has had will would can could should im ive le la les des du de une et pour dans avec sur qui que quoi quel quelle quels quelles est sont mon mes ce cet cette ces au aux en par ne pas je tu nous vous ou où combien comment quand "
# Words are split on anything that is not a letter or digit in ANY alphabet, so "électricien" stays one word (the old a-z0-9 split cut it at
# the accent into pieces that matched nothing). The FTS tokenizer then folds accents and case the same way it did when indexing.
tok="$(printf '%s' "$Q" | /usr/bin/perl -CS -ne 'print join(" ", lc($_) =~ /[\p{L}\p{N}]+/g), "\n"; print(/[\x{c0}-\x{24f}]/ ? "1" : "0")')"
words="${tok%%$'\n'*}"; accented="${tok##*$'\n'}"
match=""
terms=()
qfr=0
[ "$accented" = 1 ] && qfr=1
for w in $words; do
  case " le la les des une pour dans est que qui mon mes ce cet cette avec sur du au aux je quel quelle quels quelles combien comment quand " in *" $w "*) qfr=1;; esac
  [ "${#w}" -ge 2 ] || continue
  case "$STOP" in *" $w "*) continue;; esac
  terms+=("$w")
  match+="\"$w\" OR "
done
# Generic words (notes, files, documents ...) name the kind of thing, not the subject, and match most of a notes folder. They are dropped
# only when the query has at least one other real word; a query made only of generic words keeps them.
if [ "${#terms[@]}" -ge 2 ]; then
  specific=()
  for w in "${terms[@]}"; do
    case " note notes file files document documents docs fichiers " in *" $w "*) ;; *) specific+=("$w");; esac
  done
  if [ "${#specific[@]}" -ge 1 ] && [ "${#specific[@]}" -lt "${#terms[@]}" ]; then
    terms=("${specific[@]}")
    match=""
    for w in "${terms[@]}"; do match+="\"$w\" OR "; done
  fi
fi
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

# A large text (over 800,000 characters) is indexed as sections, one row each with the same path (build-fts.sh; meta.sections counts those rows).
# Only when there are some, a hit is one row per PATH: the best section stands for the file, and a line "      sections: 3/250:40000 7/250:140000" lists
# every section that matched (N of M, and the character each starts at), best first.
SECTIONS="$(sqlite3 "$DB" 'SELECT sections FROM meta LIMIT 1;' 2>/dev/null || true)"; [[ "$SECTIONS" =~ ^[0-9]+$ ]] || SECTIONS=0
# NB_FTS_LIST=1 prints the path of EVERY note that matches (unranked, one per line) and stops: the server counts them by folder and year.
if [ "${NB_FTS_LIST:-0}" = 1 ]; then
  sqlite3 "$DB" "SELECT DISTINCT path FROM notes WHERE notes MATCH '$match';" 2>/dev/null
  exit 0
fi

# bm25() is negative (more negative = better); ORDER BY it ascending = best first. It's an FTS
# auxiliary function usable only in the MATCH query itself (not inside a window fn), so rank the
# top-N in an inner query, then number them in the outer. path is already stored in ~ form.
#
# Default BM25 (equal column weights). NOTE (2026-07-06, search-fix Session 16): a column-weighted
# variant bm25(notes,0.0,10.0,2.0,6.0,1.0) was tried (title×10/keywords×6) to fix H9/H10 sibling-
# crowding + surface container-type tokens, but the blind gate showed 0 bar improvement AND a trap-
# honesty regression (purpose-word junk queries stopped weak-flagging). REVERTED here to default.
BM25='bm25(notes)'
# rowid breaks ties, so identical-scoring notes (copies of one file) come in the same order for every page.
SNIP=""
[ "${NB_FTS_SNIPPET:-0}" = 1 ] && SNIP=" || char(10) || '      excerpt: ' || replace(replace(snip, char(10), ' '), char(13), ' ')"
SNIPCOL=""
[ "${NB_FTS_SNIPPET:-0}" = 1 ] && SNIPCOL=", snippet(notes, 4, '', '', '…', 32) AS snip"
# NB_FTS_TITLE=1 prints under each hit one line "      title: ..." (before the excerpt) with the title the index holds for it.
TTL=""
[ "${NB_FTS_TITLE:-0}" = 1 ] && { TTL=" || char(10) || '      title: ' || replace(replace(ttl, char(10), ' '), char(13), ' ')"; SNIPCOL="$SNIPCOL, title AS ttl"; }
total=""
if [ "${NB_FTS_COUNT:-0}" = 1 ]; then
  total="$(sqlite3 "$DB" "SELECT count(DISTINCT path) FROM notes WHERE notes MATCH '$match';" 2>/dev/null)"
  [[ "$total" =~ ^[0-9]+$ ]] && echo "matches: $total"
fi
if [ "$SECTIONS" -gt 0 ]; then
  EXTRA=""; [ "${NB_FTS_SNIPPET:-0}" = 1 ] && EXTRA="$EXTRA, snip"; [ "${NB_FTS_TITLE:-0}" = 1 ] && EXTRA="$EXTRA, ttl"
  # length(), not != '': a window group_concat of only empty strings is an odd value (hex 00) that compares unequal to ''
  SECS=" || CASE WHEN length(trim(coalesce(secs, ''))) > 0 THEN char(10) || '      sections: ' || secs ELSE '' END"
  out="$(sqlite3 "$DB" "SELECT printf('%2d  %8.2f  %s', ROW_NUMBER() OVER (ORDER BY score, rid) + $OFFSET, score, path)$SECS$TTL$SNIP FROM (SELECT score, rid, path, secs$EXTRA FROM (SELECT score, rid, path$EXTRA, ROW_NUMBER() OVER (PARTITION BY path ORDER BY score, rid) AS rn, group_concat(sec, ' ') OVER (PARTITION BY path ORDER BY score, rid ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS secs FROM (SELECT $BM25 AS score, path, rowid AS rid, sec$SNIPCOL FROM notes WHERE notes MATCH '$match')) WHERE rn = 1 ORDER BY score, rid LIMIT $LIMIT OFFSET $OFFSET) ORDER BY score, rid;" 2>&1)"
else
out="$(sqlite3 "$DB" "SELECT printf('%2d  %8.2f  %s', ROW_NUMBER() OVER (ORDER BY score, rid) + $OFFSET, score, path)$TTL$SNIP FROM (SELECT $BM25 AS score, path, rowid AS rid$SNIPCOL FROM notes WHERE notes MATCH '$match' ORDER BY $BM25, rowid LIMIT $LIMIT OFFSET $OFFSET) ORDER BY score, rid;" 2>&1)"
fi
rc=$?
if [ "$rc" -ne 0 ]; then echo "fts error: $out" >&2; exit 1; fi
# French branch: when the question looks French (a French function word or an accented letter), the same query also runs on moc/fts_fr.db,
# a French-only copy of the index (build-fts-fr.sh) where BM25's statistics are not set by the English notes around a French one. Its top 5
# are merged with the main list by reciprocal rank (weight NB_WF, 0.8). Only rows the main index also has are used. NB_XL=off turns it off. OFF BY DEFAULT since 0.1.31: it runs only with NB_FR_INDEX=on (which build-fts.sh also needs to build fts_fr.db).
FR_DB="$(dirname "$DB")/fts_fr.db"
if [ -n "$out" ] && [ "$OFFSET" = 0 ] && [ "${NB_FTS_SNIPPET:-0}" != 1 ] && [ "$qfr" = 1 ] && [ "${NB_XL:-fr}" != off ] && [ "${NB_FR_INDEX:-off}" = on ] && [ -f "$FR_DB" ]; then
  ofr="$(sqlite3 -readonly "$FR_DB" "ATTACH DATABASE '$DB' AS m; SELECT printf('%2d  %8.2f  %s', ROW_NUMBER() OVER (ORDER BY score), score, path) FROM (SELECT bm25(notes) AS score, path FROM notes WHERE notes MATCH '$match' AND path IN (SELECT path FROM m.notes) ORDER BY bm25(notes) LIMIT 5);" 2>/dev/null)"
  if [ -n "$ofr" ]; then
    out="$(printf 'O\n%s\nX\n%s\n' "$out" "$ofr" | awk -v lim="$LIMIT" -v wx="${NB_WF:-0.8}" -v kr=5 '
      /^O$/{src="O"; r=0; next} /^X$/{src="X"; r=0; next}
      NF{ p=$0; sc=$2+0; sub(/^ *[0-9]+ +[-0-9.]+ +/,"",p); r++
          if(!(p in best)){ best[p]=sc; ord[p]=++seen }
          f[p] += ((src=="O")?1.0:wx)/(kr+r) }
      END{ n=0; for(q in f){n++; key[n]=q}
           for(i=1;i<=n;i++) for(j=i+1;j<=n;j++) if(f[key[j]]>f[key[i]] || (f[key[j]]==f[key[i]] && ord[key[j]]<ord[key[i]])){t=key[i];key[i]=key[j];key[j]=t}
           for(i=1;i<=n && i<=lim;i++) printf "%2d  %8.2f  %s\n", i, best[key[i]], key[i] }')"
  fi
fi
if [ -z "$out" ]; then
  # a page past the end of a list that has matches is empty, not "no matches"
  [ "${total:-0}" -gt 0 ] 2>/dev/null || echo "no matches for: $Q"
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
    # a later page: the weak-match judgement is about the best hit of the whole list, not the first of this page
    if [ "$OFFSET" -gt 0 ]; then
      top="$(sqlite3 "$DB" "SELECT path FROM notes WHERE notes MATCH '$match' ORDER BY $BM25, rowid LIMIT 1;" 2>/dev/null)"
    fi
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
    # The label needs BOTH readings (0.1.31 A/B on invented notes: 128 wrong calls of 331 against 204 for coverage alone and 144 for margin alone, and
    # the fewest answers wrongly called "not found"): the top hit matches at most half the query words, AND it stands less than NB_MARGIN (8%) above
    # the next result of the whole ranking (never of the current page or an offset page). One result alone counts as no margin.
    # Only when the top hit rests on ONE query word (m <= 1): held-out A/B (invented notes, 164 queries) plus the 331-query set, 0.1.31 pre-test: the
    # old "at most half the words" test labelled answerable queries weak 77 and 14 times (padded questions whose top hit matches 2 of 5 words);
    # with m <= 1 it is 27 and 12, missed "not found" +1 and 0.
    if [ "$m" -le 1 ] && [ $((m * 2)) -le "$nterms_full" ]; then
      if [ "$SECTIONS" -gt 0 ]; then   # a large text's sections are one hit: its best section stands for it
      sc="$(sqlite3 "$DB" "SELECT group_concat(score, ' ') FROM (SELECT min(score) AS score FROM (SELECT $BM25 AS score, path FROM notes WHERE notes MATCH '$match' LIMIT 100000000) GROUP BY path ORDER BY min(score) LIMIT 2);" 2>/dev/null)"
    else
      sc="$(sqlite3 "$DB" "SELECT group_concat(score, ' ') FROM (SELECT $BM25 AS score FROM notes WHERE notes MATCH '$match' ORDER BY $BM25, rowid LIMIT 2);" 2>/dev/null)"
    fi
      set -- $sc; s1="${1:-}"; s2="${2:-$s1}"
      if [ -n "$s1" ]; then awk -v s1="$s1" -v s2="$s2" -v t="${NB_MARGIN:-0.08}" -v m="$m" -v n="$nterms_full" 'BEGIN{ rm = (s1<0) ? (s2-s1)/(-s1) : 0
        if (rm < t) printf "⚠ WEAK MATCH: top hit matches only %d/%d query words and stands only %.1f%% above the next result\n", m, n, rm*100 }'; fi
    fi
  fi
fi
