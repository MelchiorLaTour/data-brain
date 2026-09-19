#!/usr/bin/env bash
# verify-install.sh — machine-checked acceptance gates for a NewBrain install.
# [no LLM needed] Run anytime: bash verify-install.sh
#
#   bash verify-install.sh                          # after install: all gates
#   bash verify-install.sh --preflight [ROOT...]    # BEFORE install: environment + roots only
#
# --preflight is read-only and advisory: install.sh does not require it to pass. It exists so a
# missing dependency is a five-second refusal instead of a crash halfway through an install.
# Exit 0 = all hard checks PASS (warnings allowed); exit 1 = at least one FAIL.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PREFLIGHT=0
PFROOTS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --preflight) PREFLIGHT=1; shift ;;
    -h|--help) echo "usage: bash verify-install.sh [--preflight [ROOT...]]"; exit 0 ;;
    *) PFROOTS+=("$1"); shift ;;
  esac
done

pass=0; fail=0; warn=0
ok()   { echo "PASS  $1"; pass=$((pass+1)); }
bad()  { echo "FAIL  $1"; fail=$((fail+1)); }
note() { echo "WARN  $1"; warn=$((warn+1)); }

# 1. dependencies
command -v rg >/dev/null 2>&1      && ok "rg (ripgrep) present"      || bad "rg missing — brew install ripgrep"
command -v sqlite3 >/dev/null 2>&1 && ok "sqlite3 present"           || bad "sqlite3 missing"

if [ "$PREFLIGHT" -eq 1 ]; then
  # --- pre-install only: the environment and the roots you are about to index ---------------
  echo "(preflight is advisory — install.sh does not require it to pass)"

  # FTS5 is a compile-time option. A sqlite3 without it passes the command -v check above,
  # installs and runs normally, then fails at build-fts.sh — a confusing place to find out.
  if command -v sqlite3 >/dev/null 2>&1; then
    if sqlite3 :memory: "CREATE VIRTUAL TABLE t USING fts5(x);" >/dev/null 2>&1; then
      ok "sqlite3 has FTS5 (ranked search will build)"
    else
      bad "sqlite3 lacks FTS5 — moc/fts.db cannot be built. macOS: brew install sqlite, then put it ahead of /usr/bin on PATH."
    fi
  fi

  missing_opt=""
  for opt in pdftotext textutil pandoc; do
    command -v "$opt" >/dev/null 2>&1 || missing_opt="$missing_opt $opt"
  done
  if [ -z "$missing_opt" ]; then
    ok "optional converters present (pdftotext, textutil, pandoc)"
  else
    note "optional converter(s) missing:$missing_opt — those formats stay title-only until installed (macOS: brew install poppler pandoc), then run bash bin/extract.sh"
  fi

  [ -w "$ROOT" ] && ok "clone directory is writable ($ROOT)" \
                 || bad "clone directory is not writable — moc/ and INSTALL-STATE.md cannot be created: $ROOT"

  if command -v pgrep >/dev/null 2>&1 && pgrep -x Obsidian >/dev/null 2>&1; then
    note "Obsidian is running — quit it before indexing so files do not change mid-scan"
  else
    ok "Obsidian not running (or not installed)"
  fi

  if [ "${#PFROOTS[@]}" -eq 0 ]; then
    note "no roots given — pass them to check: bash verify-install.sh --preflight \"\$HOME/My Vault\""
  else
    for r in "${PFROOTS[@]}"; do
      if [ ! -d "$r" ]; then bad "root is not a directory: $r"; continue; fi
      if [ ! -r "$r" ]; then bad "root is not readable: $r"; continue; fi
      if [ "$r" = "$HOME" ]; then bad "indexing all of \$HOME is almost never intended — pick the note directories instead"; continue; fi
      n="$(find "$r" \( -name '*.md' -o -name '*.txt' \) 2>/dev/null | head -20000 | wc -l | tr -d ' ')"
      b="$(find "$r" \( -name '*.pdf' -o -name '*.docx' \) 2>/dev/null | head -20000 | wc -l | tr -d ' ')"
      if [ "$n" -gt 0 ] || [ "$b" -gt 0 ]; then
        ok "root OK: $r ($n text-note files, $b pdf/docx)"
      else
        note "root has no note-like files (md/txt/pdf/docx): $r — is this the right directory?"
      fi
      [ -d "$r/.obsidian" ] && ok "  ^ Obsidian vault — fast path: ./install.sh --obsidian \"$r\""
      if [ "$b" -gt 200 ]; then
        note "  ^ $b pdf/docx files — skip the extract pass at install time and run bash bin/extract.sh afterwards"
      fi
    done
  fi

  echo ""
  echo "== preflight: $pass PASS, $fail FAIL, $warn WARN =="
  if [ "$fail" -gt 0 ]; then echo "NO-GO — fix the FAIL lines above, then re-run."; exit 1; fi
  echo "GO — run ./install.sh (see ./install.sh --help for the no-prompt flags)."
  exit 0
fi

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
  # Scan up to 200 titles, not just the first row: a short first title (e.g. "tax") yields no
  # >=4-char token and used to degrade this gate to a WARN for no real reason.
  word="$(awk -F'\t' 'NR>1 && $1 !~ /^#/ { print $2 }' moc/index.tsv | head -200 | tr -cs '[:alnum:]' '\n' | awk 'length($0) >= 4 { print tolower($0); exit }')"
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
    note "0% of rows labeled — labeling not done yet (draft a mapping: bash bin/label-by-path.sh --suggest)"
  else
    ok "labeling: $labeled/$rows rows ($pct%) have a room"
  fi
fi

echo ""
echo "== verify-install: $pass PASS, $fail FAIL, $warn WARN =="
[ "$fail" -gt 0 ] && exit 1
exit 0
