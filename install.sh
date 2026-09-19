#!/usr/bin/env bash
# install.sh — one-command NewBrain bootstrap. [no LLM needed — plain shell, run it yourself]
#   deps check → collect canonical roots → write them into bin/canon.sh → build the index →
#   optional binary-extract pass → build ranked search → smoke test.
#
# Interactive by default. Every prompt has a flag, so an agent, a script or CI can run it with
# no terminal attached:
#   ./install.sh --obsidian "$HOME/My Vault"          # single vault, zero prompts
#   ./install.sh --roots "$HOME/Notes" "$HOME/Docs"   # explicit roots, zero prompts
#   ./install.sh --roots "$HOME/Notes" --extract      # ...and run the slow extract pass now
#   ./install.sh --help
#
# The picker and the flags share ONE validate-and-write path (collect → finalize → write_canon),
# so the two entry points can never disagree about what a root is.
#
# What it deliberately does NOT do: room LABELING. Labeling needs YOUR folder→room mapping.
# `bash bin/label-by-path.sh --suggest` drafts one from your real folders; the agent step in
# INSTALL.md confirms it with you. label-by-path.sh only ever fills unlabeled ('-') rows, so
# running it before your real mapping exists would stamp labels that can never be overridden.
# Every row this script creates stays unlabeled ('-') on purpose.
#
# Re-runnable: ingest is append-only + dedup'd, extract and the FTS build are idempotent, and
# each stage is appended to INSTALL-STATE.md so an interrupted run resumes instead of restarting.
# bash 3.2 (stock macOS) compatible.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

die() { echo "ERROR: $*" >&2; exit 1; }
state() { printf '%s — %s\n' "$(date '+%H:%M')" "$1" >> INSTALL-STATE.md; }

usage() {
  cat <<'USAGE'
usage: ./install.sh [options]

  --obsidian PATH     Obsidian fast path: PATH is the single canonical root, every prompt is
                      skipped and the extract pass is skipped. Warns (does not fail) if PATH
                      has no .obsidian/ directory.
  --roots PATH...     Use these directories as the canonical roots. Skips the picker.
  --root PATH         Add one root. Repeatable.
  --extract           Run the PDF/DOCX extract pass without asking.
  --no-extract        Skip it without asking. Run it later with: bash bin/extract.sh
                      (resumable and idempotent), then bash bin/build-fts.sh
  -h, --help          This text.

With no flags and no terminal attached, the picker cannot run and this script exits 2 naming
these flags. Paths containing spaces are fine: quote them here, or enter them through the
picker's "other" option, which reads one path per line.
USAGE
}

# --- 0. arguments ------------------------------------------------------------
ROOTS=()
EXTRACT="ask"          # ask | yes | no
OBSIDIAN=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --obsidian) shift; [ "$#" -gt 0 ] || die "--obsidian needs a path"; OBSIDIAN="$1"; shift ;;
    --root)     shift; [ "$#" -gt 0 ] || die "--root needs a path"; ROOTS+=("$1"); shift ;;
    --roots)
      shift
      [ "$#" -gt 0 ] || die "--roots needs at least one path"
      while [ "$#" -gt 0 ]; do
        case "$1" in --*) break ;; esac
        ROOTS+=("$1"); shift
      done ;;
    --extract)    EXTRACT="yes"; shift ;;
    --no-extract) EXTRACT="no";  shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; echo "" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "$OBSIDIAN" ]; then
  [ -d "$OBSIDIAN" ] || die "--obsidian: not a directory: $OBSIDIAN"
  [ -d "$OBSIDIAN/.obsidian" ] || echo "note: no .obsidian/ in $OBSIDIAN — indexing it anyway as a plain root."
  ROOTS+=("$OBSIDIAN")
  [ "$EXTRACT" = "ask" ] && EXTRACT="no"
fi

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

# --- 2. collect canonical roots ------------------------------------------------
# The picker only ever APPENDS to ROOTS. Validation and writing happen once, below, for
# flags and picker alike.
collect_roots_interactive() {
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
  printf '  %d) other — type absolute paths (use this for paths containing spaces)\n' "$i"
  echo ""
  printf "Enter numbers and/or absolute paths, space-separated (e.g. '1 3' or '/Volumes/Archive'): "
  read -r picks
  [ -n "$picks" ] || { echo "nothing picked — re-run ./install.sh"; exit 1; }

  for tok in $picks; do
    case "$tok" in
      /*) ROOTS+=("$tok") ;;
      [0-9]|[0-9][0-9])
        if [ "$tok" -ge 1 ] && [ "$tok" -lt "$i" ]; then
          ROOTS+=("${CANDIDATES[$((tok-1))]}")
        elif [ "$tok" -eq "$i" ]; then
          echo "absolute paths, ONE PER LINE (spaces are fine); empty line when done:"
          while true; do
            printf '  path> '
            read -r line || break
            [ -n "$line" ] || break
            # Accept BOTH shapes: a whole line that IS a directory (spaces and all), or
            # several space-separated paths, which is how this prompt used to work.
            if [ -d "$line" ]; then
              ROOTS+=("$line")
            else
              for p in $line; do ROOTS+=("$p"); done
            fi
          done
        else
          echo "skip (no such option): $tok"
        fi ;;
      *) echo "skip (not a number or absolute path): $tok" ;;
    esac
  done
}

if [ "${#ROOTS[@]}" -eq 0 ]; then
  if [ ! -t 0 ]; then
    echo "" >&2
    echo "ERROR: no roots given and stdin is not a terminal, so the picker cannot run." >&2
    echo "Pass the roots instead:" >&2
    echo "  ./install.sh --roots \"\$HOME/Notes\"" >&2
    echo "  ./install.sh --obsidian \"\$HOME/My Vault\"" >&2
    echo "(./install.sh --help for all options)" >&2
    exit 2
  fi
  collect_roots_interactive
fi

# --- the single validate step, for flags and picker alike -----------------------
VALID=()
for r in ${ROOTS[@]+"${ROOTS[@]}"}; do
  if [ -d "$r" ]; then VALID+=("$(cd "$r" && pwd)"); else echo "skip (not a directory): $r"; fi
done
ROOTS=(${VALID[@]+"${VALID[@]}"})
[ "${#ROOTS[@]}" -eq 0 ] && { echo "no valid roots — re-run ./install.sh (see --help)"; exit 1; }
echo "roots picked:"
for r in "${ROOTS[@]}"; do echo "  $r"; done

printf -- '--- run %s ---\n' "$(date '+%Y-%m-%d %H:%M')" >> INSTALL-STATE.md
state "roots: ${#ROOTS[@]} — next: write bin/canon.sh"

# --- 3. write the roots into bin/canon.sh --------------------------------------
# awk (not sed) so paths with regex-special characters survive. The $HOME prefix is written
# back as the literal string $HOME so canon.sh stays machine-portable. Roots are passed via
# ENVIRON, not -v: BSD awk (stock macOS) rejects newlines in -v strings. Spaces survive
# because every root is written as its own quoted line.
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
state "bin/canon.sh written — next: build index"

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

# moc/ is generated and rebuildable. It ignores ITSELF, inside the folder, where anyone who
# opens it will see why and how to override — rather than the repo's root .gitignore deciding
# for every user (which would silently break deliberate index syncing).
if [ ! -f moc/.gitignore ]; then
  cat > moc/.gitignore <<'GITIGNORE'
# Generated by install.sh / refresh.sh — rebuildable from your notes, machine-specific.
# Syncing your index between machines on purpose? Use:  git add -f moc/
*
GITIGNORE
fi
state "index built: $rows rows — next: extract decision"

# --- 5. optional extract pass -----------------------------------------------------
if [ "$EXTRACT" = "ask" ]; then
  if [ ! -t 0 ]; then
    EXTRACT="no"
  else
    echo ""
    printf "Extract PDFs/docx/offloaded files into searchable sidecars now? Can be slow on a big corpus; resumable + idempotent, safe to re-run later. [y/N] "
    read -r yn
    case "$yn" in [Yy]*) EXTRACT="yes" ;; *) EXTRACT="no" ;; esac
  fi
fi
if [ "$EXTRACT" = "yes" ]; then
  bash bin/extract.sh || echo "extract.sh reported issues — safe to re-run later; continuing."
  state "extract pass run — next: build fts"
else
  echo "extract: skipped — run 'bash bin/extract.sh' anytime (resumable, idempotent), then 'bash bin/build-fts.sh'."
  state "extract skipped — next: build fts"
fi

# --- 6. ranked search index ---------------------------------------------------------
echo ""
echo "== building moc/fts.db (BM25 ranked search) =="
bash bin/build-fts.sh
state "fts.db built — next: smoke test"

# --- 7. smoke test --------------------------------------------------------------------
# Scan up to 200 titles, not just the first row: a short first title (e.g. "tax") yields no
# >=4-char token and used to skip this check in silence.
word="$(awk -F'\t' 'NR>1 && $1 !~ /^#/ { print $2 }' moc/index.tsv | head -200 | tr -cs '[:alnum:]' '\n' | awk 'length($0) >= 4 { print tolower($0); exit }')"
if [ -n "$word" ]; then
  echo ""
  echo "== smoke test: bin/fts.sh \"$word\" 3 =="
  out="$(bash bin/fts.sh "$word" 3 2>&1)" || true
  printf '%s\n' "$out"
  if printf '%s' "$out" | grep -Eq '^\s*1\s'; then
    echo "smoke test: OK (>=1 ranked hit)"
    state "smoke test OK — next: INSTALL.md step 1 (labeling)"
  else
    echo "smoke test: WARN — no ranked hit for \"$word\"; try bin/fts.sh with a topic you know you have."
    state "smoke test WARN — next: INSTALL.md step 1 (labeling)"
  fi
else
  echo "smoke test: SKIPPED — no usable word derived from titles. Run one yourself: bash bin/fts.sh <a topic you know you have> 3"
  state "smoke test skipped — next: INSTALL.md step 1 (labeling)"
fi

# --- done --------------------------------------------------------------------------------
cat <<'EOF'

== install.sh done ==
All rows are deliberately UNLABELED ('-'). Labeling is the one step that needs your taxonomy:
  1. Draft a mapping from your real folders:  bash bin/label-by-path.sh --suggest
  2. Hand INSTALL.md to your agent (open Claude Code in this directory, say "run INSTALL.md").
     It reviews that draft with you, writes bin/label-by-path.sh, labels, and rebuilds.
  3. Check the install anytime:  bash verify-install.sh
Progress is in INSTALL-STATE.md.
EOF
