#!/usr/bin/env bash
# expand.sh — query-side FR<->EN + synonym expansion (Graft 4 EXPERIMENT). ⚠ NOT WIRED INTO THE LIVE
# SEARCH PATH — measured 2026-07-07 to UNDERPERFORM Claude's own query decomposition and to fail the
# graft's ship bar. Kept as (1) the receipt for why the mechanical-expander path was rejected, and (2)
# an optional Claude-OFF cold fallback a future session could gate behind a weak-cold retry. The live
# multilingual fix is DOCTRINE (Claude decomposes NL -> tight bilingual keywords); see sectors/brain.md
# and research/RESULTS-graft4-bilingual-2026-07-07.md.
#
# What it does: tokenize the query like fts.sh, look each content word up in kw-dict.tsv BOTH ways —
#   forward  (key == word  -> add that row's expansions)   e.g. workout      -> entrainement,musculation
#   reverse  (word in vals  -> add that row's KEY)          e.g. entrainement -> workout, fitness, squat...
# then print the ORIGINAL query with the unique new terms appended. Reading the dict both directions
# makes all 194 rows bidirectional with ZERO new rows — nothing is query-targeted (the search-fix
# invariant holds: the dictionary stays corpus-derived).
#
# WHY IT WAS REJECTED (measured, research/eval/score-expand.sh): unconditional expansion helped MEDIUM
# recall (hits@3 72->90) but bled hits@1 EVERYWHERE (ALL 58->52) and did NOT move the flagship X2
# cross-lingual case off rank 0 — it pushed the target BELOW rank 10. Root cause: kw-dict maps a word to
# GENERIC synonyms, so a fitness query gets the owner's whole hobby profile stapled on (gym/running/hiking/
# software), which floats off-topic profile docs (CV, Team Charter) to the top and lifts the entire
# sibling cluster uniformly. It adds off-target MASS; the discriminating concept (split/legs/back/chest)
# is exactly what a static dict can't supply. Claude decomposition supplies it — hence doctrine, not code.
#
# Claude-OFF: pure bash + awk, no model/API/network. EXPAND_MAX caps total additions (default 24).
# Prints the (possibly expanded) query on stdout; on no dict / no additions it echoes the query
# unchanged, so `q="$(expand.sh "$raw")"` is always safe.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DICT="$ROOT/bin/kw-dict.tsv"
MAX="${EXPAND_MAX:-24}"

Q="${*:-}"
[ -n "$Q" ] || { echo "usage: expand.sh \"query\"" >&2; exit 1; }

# No dictionary -> return the query untouched (still a valid pass-through for callers).
[ -f "$DICT" ] || { printf '%s\n' "$Q"; exit 0; }

# Content words, same tokenization fts.sh uses (lowercase, non-alnum -> space, drop 1-char tokens).
words=()
for w in $(printf '%s' "$Q" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' ' '); do
  [ "${#w}" -ge 2 ] || continue
  words+=("$w")
done
[ "${#words[@]}" -ge 1 ] || { printf '%s\n' "$Q"; exit 0; }

# One awk pass over the dict per query: for each query word, emit forward expansions (key match) and
# the reverse key (word is one of the row's comma-split values). awk dedups and skips words already
# present in the query; the caller-side MAX cap then bounds the total.
add="$(awk -F'\t' -v qwords="${words[*]}" -v max="$MAX" '
  BEGIN{
    n=split(qwords, qa, " ");
    for(i=1;i<=n;i++){ have[qa[i]]=1; q[qa[i]]=1 }   # have[] = original query words (never re-add)
  }
  {
    key=$1;
    m=split($2, vals, ",");
    # forward: a query word IS this row key -> add all its values
    if(key in q){
      for(i=1;i<=m;i++){ emit(vals[i]) }
    }
    # reverse: a query word is one of this rows values -> add the key
    for(i=1;i<=m;i++){
      if(vals[i] in q){ emit(key); break }
    }
  }
  function emit(t,   _){
    gsub(/^[ \t]+|[ \t]+$/, "", t);
    if(t=="" || (t in have) || count>=max) return;
    have[t]=1; count++;
    out=(out=="")? t : out" "t;
  }
  END{ print out }
' "$DICT")"

if [ -n "$add" ]; then
  printf '%s %s\n' "$Q" "$add"
else
  printf '%s\n' "$Q"
fi
