#!/usr/bin/env bash
# abstain-check.sh — turn the single-query ⚠ WEAK MATCH (proven near-noise: fires 2/10 on traps) into
# a PATTERN across query variants, framed as a PROMPT-TO-READ, not a mechanical verdict.
#
# Why this shape (and NOT a new score): search-fix Sessions 15/16 MEASURED that no cheap mechanical
# signal — BM25, coverage, IDF, margin, dispersion, cross-variant agreement, cosine — cleanly separates
# red-team traps from real hits on this corpus. What DOES hit 10/10 trap-honesty is the BEHAVIORAL
# ritual: decompose the question into 2-3 variants, run each, READ the top hits, then answer or abstain.
# The blind scorer already reaches TRAP 0/10-junk that way; the mechanical flag alone only 2/10. So this
# tool doesn't invent a separator — it makes that winning ritual ONE COMMAND instead of a manual chore
# (Graft 1's logic, applied to the abstain side). The final call stays behavioral.
#
# It runs each variant through fts.sh (Tier 1 engine — never touches its internals, reads its output like
# look.sh does), captures each variant's ranked top hits + its own ⚠ WEAK MATCH line, then reports:
#   CONVERGENT  → variants agree on a top hit  → likely PRESENT: READ it (look.sh) before answering.
#                 This is the H13 false-abstain fix: a real note the single-query flag weak-flagged is
#                 reframed from "abstain" into "read it" — you confirm by reading, you don't auto-abstain.
#   DIVERGENT+WEAK → no shared top hit AND every variant weak/dry → likely NOT IN THE BRAIN: read the one
#                 best hit to confirm, and if it doesn't answer, abstain honestly.
#   MIXED       → some signal, no agreement → read the union of top hits, then judge.
#
# Variants: pass 2-3 explicit variant strings (Claude, the in-loop decomposer, does this best) —
#   abstain-check.sh "raw query" "keyword decomposition" "fr/en swap"
# OR pass one query and the tool generates a COLD dictionary variant (FR<->EN + synonyms from kw-dict.tsv)
# so it still works with Claude off:
#   abstain-check.sh "how have my workouts changed"
#
# Claude-OFF: pure bash, no model/API/network (the fts.sh engine + a static dictionary). ABCHK_K=N sets
# how many top hits per variant feed the convergence test (default 3).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FTS="$ROOT/bin/fts.sh"
DICT="$ROOT/bin/kw-dict.tsv"
K="${ABCHK_K:-3}"   # top-K per variant used for the agreement test

[ "$#" -ge 1 ] || { echo "usage: abstain-check.sh \"query\" [variant2 variant3 ...]" >&2; exit 1; }

# ---- build the variant list -------------------------------------------------------------------------
variants=()
if [ "$#" -ge 2 ]; then
  # caller supplied its own variants (the LLM-in-loop path) — use them verbatim.
  for v in "$@"; do variants+=("$v"); done
else
  Q="$1"
  variants+=("$Q")
  # COLD fallback: derive one dictionary variant (FR<->EN + synonym expansion). Tokenize the query the
  # same way fts.sh does, look each content word up in kw-dict.tsv, append the expansions. This is the
  # generic bilingual bridge (e.g. workout -> entrainement,musculation) so a FR-note/EN-query pair (the
  # X2 class) gets a second, differently-worded shot at the same note. NEVER query-targeted: the dict is
  # corpus-derived and static.
  if [ -f "$DICT" ]; then
    add=""
    for w in $(printf '%s' "$Q" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' ' '); do
      [ "${#w}" -ge 2 ] || continue
      exp="$(awk -F'\t' -v t="$w" '$1==t{print $2; exit}' "$DICT")"
      [ -n "$exp" ] && add="$add ${exp//,/ }"
    done
    if [ -n "$add" ]; then
      variants+=("$Q$add")
    fi
  fi
fi
N="${#variants[@]}"

# ---- run each variant through the engine, capture ranked hits + its weak flag -----------------------
# top1[i]/top2[i] = rank-1/rank-2 path of variant i; topset accumulates every top-K path (for agreement).
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
weak_all=1   # becomes 0 the moment any variant returns a NON-weak, non-empty result
nomatch_all=1
declare -a TOP1

printf 'ABSTAIN-CHECK: "%s"   (%d variant%s, top-%d)\n' "${variants[0]}" "$N" "$([ "$N" -eq 1 ] && echo '' || echo 's')" "$K"
[ "$N" -eq 1 ] && printf '  (single variant — pass 2-3 hand-decomposed variants for a real cross-variant sweep)\n'

i=0
for v in "${variants[@]}"; do
  i=$((i+1))
  out="$(bash "$FTS" "$v" "$K" 2>/dev/null)"
  printf '\n── variant %d: %s\n' "$i" "$v"
  if [ -z "$out" ] || printf '%s' "$out" | grep -q '^no matches\|^no content words'; then
    printf '   (no matches)\n'
    TOP1[$i]=""
    continue
  fi
  nomatch_all=0
  # ranked hit lines, plus pass the ⚠ WEAK MATCH advisory through verbatim
  printf '%s\n' "$out" | while IFS= read -r line; do printf '   %s\n' "$line"; done
  # record this variant's top-K paths into the agreement pool, and its rank-1 path
  ranks="$(printf '%s\n' "$out" | grep -E '^ *[0-9]+ +[-0-9.]+ +~' | head -"$K" \
           | sed -E 's/^ *[0-9]+ +[-0-9.]+ +//')"
  printf '%s\n' "$ranks" >> "$tmp"
  TOP1[$i]="$(printf '%s\n' "$ranks" | head -1)"
  # this variant is "strong" iff fts did NOT weak-flag it
  if ! printf '%s' "$out" | grep -q '⚠ WEAK MATCH'; then weak_all=0; fi
done

# ---- convergence test: a path in the top-K of >=2 variants is "shared" (the single meaningful floor;
# with N==1 there is no cross-variant test, so the one variant's own hit stands). ceil(N/2) was wrong —
# at N==2 it made "shared" trivially true (>=1), so every 2-variant run looked convergent. -----------
if [ "$N" -ge 2 ]; then need=2; else need=1; fi
shared="$(sort "$tmp" 2>/dev/null | uniq -c | awk -v n="$need" '$1>=n{sub(/^ *[0-9]+ /,""); print}')"
# a shared path is a CONVERGENCE ANCHOR if it is also some variant's rank-1 hit
anchor=""
if [ -n "$shared" ]; then
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    for j in $(seq 1 "$N"); do
      if [ "${TOP1[$j]:-}" = "$p" ]; then anchor="$p"; break; fi
    done
    [ -n "$anchor" ] && break
  done <<< "$shared"
  [ -z "$anchor" ] && anchor="$(printf '%s\n' "$shared" | head -1)"   # shared but not rank-1 anywhere
fi

# ---- verdict (ADVISORY — routes to a read either way; the abstain DECISION stays behavioral) --------
# CONVERGENT only counts when at least one variant is a STRONG (non-weak) match. Agreement among
# variants that ALL weak-flagged is shared-junk, not real convergence: BM25's OR-matching floats the
# same high-frequency note to the top of unrelated queries (measured — a "scuba diving in bali" trap
# converged on an unrelated work PDF across 2 variants). Gating agreement on fts.sh's own weak flag
# (weak_all==0) collapses that false-CONVERGENT back to DIVERGENT+WEAK. Generic, not query-targeted.
# MEASURED 2026-07-06 (behavioral blind score): route→read→judge = TRAP 10/10 honest-abstain, HARD 8/10,
# 0 false-abstain. But the convergence WORD is confidently wrong on its own — on traps it "agrees" while
# pointing at a keyword-decoy, and it missed 2 HARD by converging on a decoy. The READ is what corrects it
# every time (snippets sufficed). So every branch ROUTES TO A READ and makes NO present/absent claim: the
# word is a reading order, never the answer. Do NOT abstain or answer on the word alone.
printf '\n── convergence (a reading hint, NOT a verdict — READ, then judge)\n'
if [ "$nomatch_all" -eq 1 ]; then
  printf 'DRY → no variant matched anything. Nothing to read.\n'
  printf '   → try one more rephrase; if it is still dry, that is your strongest "not in the brain" signal.\n'
elif [ -n "$anchor" ] && [ "$weak_all" -eq 0 ]; then
  printf 'CONVERGENT → %d+/%d variants share a strong top hit:\n   %s\n' "$need" "$N" "$anchor"
  printf '   → READ IT FIRST:  bash bin/look.sh "%s"\n' "${variants[0]}"
  printf '   agreement can collide on a DECOY — confirm the note actually answers before you rely on it.\n'
elif [ "$weak_all" -eq 1 ]; then
  printf 'DIVERGENT + WEAK → no strong shared hit; every variant weak-flagged.\n'
  printf '   → READ the single best hit to confirm. If it does not actually answer, abstain honestly.\n'
else
  printf 'MIXED → some signal, no cross-variant agreement.\n'
  printf '   → READ the union of top hits (look.sh), then answer or abstain on what you read.\n'
fi
exit 0
