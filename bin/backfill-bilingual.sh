#!/bin/bash
# backfill-bilingual.sh — one-time generic bilingual FR<->EN + synonym/hypernym keyword
# backfill over moc/index.tsv, driven by bin/kw-dict.tsv (2026-07-05, HYGIENE+ item 5).
# Pure bash/awk. Runs to a FIXED POINT (additions can themselves be dict keys, e.g.
# lease->bail->lease), so a re-run after convergence changes nothing. Only APPENDS to
# the keywords column; never clobbers, never touches '-' rows, index.tsv only.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
IDX="$DIR/moc/index.tsv"
DICT="$DIR/bin/kw-dict.tsv"
[ -f "$IDX" ] || { echo "no index.tsv" >&2; exit 1; }
[ -f "$DICT" ] || { echo "no kw-dict.tsv" >&2; exit 1; }

pass_n=0
while : ; do
  pass_n=$((pass_n+1))
  [ "$pass_n" -gt 6 ] && { echo "no convergence after 6 passes — aborting" >&2; exit 1; }
  TMP="$(mktemp)"
  awk -F'\t' -v OFS='\t' -v dict="$DICT" '
  BEGIN {
    while ((getline line < dict) > 0) {
      if (line ~ /^#/ || line == "") continue
      split(line, kv, "\t")
      map[kv[1]] = kv[2]
    }
    close(dict)
    rows_changed = 0; toks_added = 0
  }
  NR == 1 || $4 == "-" || NF < 4 { print; next }
  {
    delete have
    n = split($4, cur, ",")
    for (i = 1; i <= n; i++) have[tolower(cur[i])] = 1
    add = ""
    for (i = 1; i <= n; i++) {
      t = tolower(cur[i])
      m = split(t, parts, "-")
      for (p = 0; p <= m; p++) {
        key = (p == 0 ? t : parts[p])
        if (p > 0 && m == 1) continue
        if (key in map) {
          k = split(map[key], adds, ",")
          for (j = 1; j <= k; j++) {
            a = tolower(adds[j])
            if (!(a in have)) { have[a] = 1; add = add "," a; toks_added++ }
          }
        }
      }
    }
    if (add != "") { $4 = $4 add; rows_changed++ }
    print
  }
  END { printf "pass: rows_changed=%d tokens_added=%d\n", rows_changed, toks_added > "/dev/stderr" }
  ' "$IDX" > "$TMP"
  if [ "$(wc -l < "$TMP")" -ne "$(wc -l < "$IDX")" ]; then
    echo "row count changed — aborting, index untouched" >&2; rm -f "$TMP"; exit 1
  fi
  if cmp -s "$TMP" "$IDX"; then
    rm -f "$TMP"
    echo "backfill-bilingual: CONVERGED after $((pass_n-1)) applying pass(es)" >&2
    break
  fi
  mv "$TMP" "$IDX"
done
