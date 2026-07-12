#!/usr/bin/env bash
# verify-install.sh — machine-checked acceptance gates for a NewBrain install.
# [no LLM needed] Run anytime: bash verify-install.sh
# Exit 0 = all hard checks PASS (warnings allowed); exit 1 = at least one FAIL.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

pass=0; fail=0; warn=0
ok()   { echo "PASS  $1"; pass=$((pass+1)); }
bad()  { echo "FAIL  $1"; fail=$((fail+1)); }
note() { echo "WARN  $1"; warn=$((warn+1)); }

# 1. dependencies
command -v rg >/dev/null 2>&1      && ok "rg (ripgrep) present"      || bad "rg missing — brew install ripgrep"
command -v sqlite3 >/dev/null 2>&1 && ok "sqlite3 present"           || bad "sqlite3 missing"

# 2. canon.sh sources clean, CANON non-empty, roots exist
if bash -c "set -u; ROOT='$ROOT'; source bin/canon.sh" >/dev/null 2>&1; then
  ok "bin/canon.sh sources clean"
  nroots="$(bash -c "set -u; ROOT='$ROOT'; source bin/canon.sh; echo \${#CANON[@]}")"
  if [ "${nroots:-0}" -gt 0 ]; then
    ok "CANON has $nroots root(s)"
    missing_roots="$(bash -c "set -u; ROOT='$ROOT'; source bin/canon.sh; for r in \"\${CANON[@]}\"; do [ -d \"\$r\" ] || echo \"\$r\"; done")"
    if [ -z "$missing_roots" ]; then
      ok "every CANON root exists on disk"
    else
      bad "CANON root(s) missing on disk: $missing_roots"
    fi
  else
    bad "CANON is empty — run ./install.sh (or edit bin/canon.sh)"
  fi
else
  bad "bin/canon.sh fails to source — syntax or unbound-variable error"
fi

# 3. index.tsv exists with data rows
if [ -s moc/index.tsv ]; then
  rows="$(awk -F'\t' 'NR>1 && $1 !~ /^#/' moc/index.tsv | wc -l | tr -d ' ')"
  if [ "$rows" -gt 0 ]; then ok "moc/index.tsv has $rows data rows"; else bad "moc/index.tsv has no data rows — run ./install.sh"; fi
else
  bad "moc/index.tsv missing/empty — run ./install.sh"
  rows=0
fi

# 4. fts.db exists and is populated
if [ -f moc/fts.db ]; then
  cnt="$(sqlite3 moc/fts.db "SELECT count(*) FROM notes;" 2>/dev/null || echo 0)"
  if [ "${cnt:-0}" -gt 0 ]; then ok "moc/fts.db populated ($cnt rows)"; else bad "moc/fts.db empty/unreadable — run bash bin/build-fts.sh"; fi
else
  bad "moc/fts.db missing — run bash bin/build-fts.sh"
fi

# 5. fts.sh smoke query returns a ranked hit
if [ -f moc/fts.db ] && [ "${rows:-0}" -gt 0 ]; then
  word="$(awk -F'\t' 'NR>1 && $1 !~ /^#/ { print $2; exit }' moc/index.tsv | tr -cs '[:alnum:]' '\n' | awk 'length($0) >= 4 { print tolower($0); exit }')"
  if [ -n "$word" ]; then
    if bash bin/fts.sh "$word" 3 2>/dev/null | grep -Eq '^\s*1\s'; then
      ok "fts.sh smoke query (\"$word\") returns ranked hits"
    else
      bad "fts.sh smoke query (\"$word\") returned nothing — rebuild with bash bin/build-fts.sh"
    fi
  else
    note "could not derive a smoke-test word from index.tsv titles"
  fi
fi

# 6. labeling progress (WARN only — labeling is the agent-assisted INSTALL.md step)
if [ "${rows:-0}" -gt 0 ]; then
  labeled="$(awk -F'\t' 'NR>1 && $1 !~ /^#/ && $3 != "-" && $3 != ""' moc/index.tsv | wc -l | tr -d ' ')"
  pct=$(( labeled * 100 / rows ))
  if [ "$labeled" -eq 0 ]; then
    note "0% of rows labeled — labeling not done yet (INSTALL.md agent step: mapping -> label-by-path.sh)"
  else
    ok "labeling: $labeled/$rows rows ($pct%) have a room"
  fi
fi

echo ""
echo "== verify-install: $pass PASS, $fail FAIL, $warn WARN =="
[ "$fail" -eq 0 ] && exit 0 || exit 1
