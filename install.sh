#!/usr/bin/env bash
# install.sh — one-command NewBrain bootstrap. [no LLM needed — plain shell, run it yourself]
#   deps check → pick canonical roots → write them into bin/canon.sh → build the index →
#   optional binary-extract pass → build ranked search → smoke test.
#
# What it deliberately does NOT do: room LABELING. Labeling needs YOUR folder→room mapping,
# which the agent-assisted step in INSTALL.md proposes from your real folders and confirms
# with you. label-by-path.sh only ever fills unlabeled ('-') rows, so running it before your
# real mapping exists would stamp labels that can never be overridden. Every row this script
# creates stays unlabeled ('-') on purpose.
#
# Re-runnable: ingest is append-only + dedup'd; extract and the FTS build are idempotent.
# bash 3.2 (stock macOS) compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "== NewBrain install =="

# --- 1. dependencies ---------------------------------------------------------
missing=0
command -v rg >/dev/null 2>&1      || { echo "MISSING: rg (ripgrep) — macOS: brew install ripgrep"; missing=1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "MISSING: sqlite3 — ships with macOS; linux: apt/dnf install sqlite3"; missing=1; }
[ "$missing" -eq 1 ] && { echo "install the missing dependencies and re-run ./install.sh"; exit 1; }
echo "deps: rg + sqlite3 present."
for opt in pdftotext textutil pandoc; do
  command -v "$opt" >/dev/null 2>&1 || echo "note: optional converter '$opt' not found — extract.sh will skip formats needing it."
done

# --- 2. pick canonical roots ---------------------------------------------------
echo ""
echo "Pick your CANONICAL ROOTS — the directory trees holding notes/documents worth indexing."
echo "(Nothing is ever moved, renamed, or copied; the brain only reads.)"
CANDIDATES=()
for d in "$HOME/Notes" "$HOME/Documents" "$HOME/Desktop" "$HOME/Downloads"; do
  [ -d "$d" ] && CANDIDATES+=("$d")
done
i=1
for d in ${CANDIDATES[@]+"${CANDIDATES[@]}"}; do
  n="$(find "$d" -maxdepth 3 \( -name '*.md' -o -name '*.pdf' -o -name '*.txt' -o -name '*.docx' \) 2>/dev/null | head -500 | wc -l | tr -d ' ')"
  printf '  %d) %s  (~%s note-like files, shallow sample)\n' "$i" "$d" "$n"
  i=$((i+1))
done
printf '  %d) other — type absolute paths\n' "$i"
echo ""
printf "Enter numbers and/or absolute paths, space-separated (e.g. '1 3' or '/Volumes/Archive'): "
read -r picks
[ -n "$picks" ] || { echo "nothing picked — re-run ./install.sh"; exit 1; }

ROOTS=()
for tok in $picks; do
  case "$tok" in
    /*) if [ -d "$tok" ]; then ROOTS+=("$tok"); else echo "skip (not a directory): $tok"; fi ;;
    [0-9]|[0-9][0-9])
      if [ "$tok" -ge 1 ] && [ "$tok" -lt "$i" ]; then
        ROOTS+=("${CANDIDATES[$((tok-1))]}")
      elif [ "$tok" -eq "$i" ]; then
        printf 'absolute paths (space-separated, no spaces IN a path — edit bin/canon.sh by hand for those): '
        read -r extras
        for e in $extras; do
          if [ -d "$e" ]; then ROOTS+=("$e"); else echo "skip (not a directory): $e"; fi
        done
      else
        echo "skip (no such option): $tok"
      fi ;;
    *) echo "skip (not a number or absolute path): $tok" ;;
  esac
done
[ "${#ROOTS[@]}" -eq 0 ] && { echo "no valid roots — re-run ./install.sh"; exit 1; }
echo "roots picked:"
for r in "${ROOTS[@]}"; do echo "  $r"; done

# --- 3. write the roots into bin/canon.sh --------------------------------------
# awk (not sed) so paths with regex-special characters survive. $HOME prefix is written
# back as the literal string $HOME so canon.sh stays machine-portable. Roots are passed
# via ENVIRON, not -v: BSD awk (stock macOS) rejects newlines in -v strings.
roots_joined=""
for r in "${ROOTS[@]}"; do
  roots_joined="$roots_joined${r/#$HOME/\$HOME}"$'\n'
done
vault="${ROOTS[0]/#$HOME/\$HOME}"
tmp="$(mktemp)"
ROOTS_JOINED="$roots_joined" awk -v vault="$vault" '
  BEGIN { n = split(ENVIRON["ROOTS_JOINED"], R, "\n") }
  /^VAULT=/ && !vdone { print "VAULT=\"" vault "\""; vdone = 1; next }
  /^CANON=\(/ && !cdone {
    print "CANON=("
    for (i = 1; i <= n; i++) if (R[i] != "") print "  \"" R[i] "\""
    incanon = 1; cdone = 1; next
  }
  incanon { if ($0 ~ /^\)/) { print ")"; incanon = 0 }; next }
  { print }
' bin/canon.sh > "$tmp" && mv "$tmp" bin/canon.sh
bash -n bin/canon.sh || { echo "ERROR: rewritten bin/canon.sh failed syntax check — restore from git and re-run"; exit 1; }
echo "bin/canon.sh updated: VAULT=\"$vault\" + ${#ROOTS[@]} root(s). (Junk-folder prunes: edit the EDIT: blocks in bin/canon.sh anytime.)"

# --- 4. build the index ---------------------------------------------------------
echo ""
echo "== building moc/index.tsv =="
bash bin/build-index.sh                      # seeds .md rows; creates moc/ + index.tsv
for r in "${ROOTS[@]}"; do
  echo "-- ingest: $r"
  bash bin/ingest-root.sh "$r"               # appends pdf/docx/txt etc.; dedup'd, append-only
done
rows="$(awk -F'\t' 'NR>1 && $1 !~ /^#/' moc/index.tsv | wc -l | tr -d ' ')"
echo "index.tsv: $rows rows."
[ "$rows" -gt 0 ] || { echo "ERROR: index is empty — are the picked roots really where your notes live?"; exit 1; }

# --- 5. optional extract pass -----------------------------------------------------
echo ""
printf "Extract PDFs/docx/offloaded files into searchable sidecars now? Can be slow on a big corpus; resumable + idempotent, safe to re-run later. [y/N] "
read -r yn
case "$yn" in
  [Yy]*) bash bin/extract.sh || echo "extract.sh reported issues — safe to re-run later; continuing." ;;
  *) echo "skipped — run 'bash bin/extract.sh' anytime." ;;
esac

# --- 6. ranked search index ---------------------------------------------------------
echo ""
echo "== building moc/fts.db (BM25 ranked search) =="
bash bin/build-fts.sh

# --- 7. smoke test --------------------------------------------------------------------
word="$(awk -F'\t' 'NR>1 && $1 !~ /^#/ { print $2; exit }' moc/index.tsv | tr -cs '[:alnum:]' '\n' | awk 'length($0) >= 4 { print tolower($0); exit }')"
if [ -n "$word" ]; then
  echo ""
  echo "== smoke test: bin/fts.sh \"$word\" 3 =="
  out="$(bash bin/fts.sh "$word" 3 2>&1)" || true
  printf '%s\n' "$out"
  if printf '%s' "$out" | grep -Eq '^\s*1\s'; then
    echo "smoke test: OK (>=1 ranked hit)"
  else
    echo "smoke test: WARN — no ranked hit for \"$word\"; try bin/fts.sh with a topic you know you have."
  fi
fi

# --- done --------------------------------------------------------------------------------
cat <<'EOF'

== install.sh done ==
All rows are deliberately UNLABELED ('-'). Labeling is the one step that needs your taxonomy:
  1. Hand INSTALL.md to your agent (open Claude Code in this directory, say "run INSTALL.md").
     It proposes your folder->room mapping, writes bin/label-by-path.sh, labels, and rebuilds.
  2. Check the install anytime:  bash verify-install.sh
EOF
