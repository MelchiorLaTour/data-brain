#!/usr/bin/env bash
# canon.sh — the SINGLE list of canonical content roots NewBrain indexes.
# Sourced by search.sh AND rebuild.sh so the search corpus and the derived index can
# never disagree about where content lives. Content lives ONCE in these homes; NewBrain
# copies nothing. Add a pile = add its canonical root here, then rerun rebuild.sh.
#
# TEMPLATE — EDIT: set VAULT and CANON to YOUR machine's real note homes.
# The INSTALL.md bootstrap proposes these from your actual folders and confirms with you.
# VAULT is only used by file-note.sh as its capture destination; point it at wherever
# new quick-capture notes should land.
VAULT="$HOME/Notes"
CANON=(
  # EDIT: your roots — every directory tree that holds notes/documents worth indexing.
  # One example root active; common additions commented out below.
  "$HOME/Notes"
  # "$HOME/Downloads"        # deliverables (resumes, letters, exported docs)
  # "$HOME/Documents"        # essays, coursework, long-form docs
  # "$HOME/Desktop"          # working folders (prune app/game junk below)
)
# Paths pruned from BOTH the index and the search corpus, so search.sh + ingest-root.sh + rebuild
# always agree on what is in scope. Two kinds:
#   1. HARD-BLOCKED — a Sensitive folder for credentials (also enforceable by a PreToolUse
#      hard-block hook; see README security notes).
#   2. NON-NOTE MACHINERY / APP+GAME DATA — keeps the brain to NOTES and protects the north star
#      (lowest context on load). Whole-laptop roots are full of generated/app files that are not notes.
#      This list GROWS as new junk roots surface (label/signs model); add a pattern, never move a file.
# Self-prune: the brain's own machinery (moc/, bin/, catalog/) must never index itself.
# NB_SELF = this clone's root — derived from ROOT when the consumer script set it before
# sourcing canon.sh (every bin/ script does); the fallback covers sourcing canon.sh bare.
# EDIT the fallback if your clone lives elsewhere.
NB_SELF="${ROOT:-$HOME/Claude/NewBrain}"
PRUNE_FIND=(
  -not -path '*/Resources/Sensitive/*'
  -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.obsidian/*'
  -not -path '*/.planning/*' -not -path '*/.venv/*' -not -path '*/venv/*'
  -not -path '*/__pycache__/*' -not -path '*/.cache/*' -not -path '*/Library/*'
  -not -path '*.app/*' -not -path '*/dist/*' -not -path '*/build/*'
  -not -path '*/.claude/*' -not -path '*/worktrees/*'         # per-project Claude scaffolding + git worktrees
  # EDIT: add your own app/game junk roots here, e.g.:
  # -not -path '*/SomeApp/*'
  # -not -path "$HOME/Desktop/Games/*"
  -not -path "$NB_SELF/moc/*" -not -path "$NB_SELF/bin/*"
  -not -path "$NB_SELF/catalog/*"
  # EDIT: if the brain's real note bytes live in a separate folder OUTSIDE this clone,
  # prune that too (no self-indexing), e.g.:
  # -not -path "$HOME/Desktop/NewBrain/*"
)
PRUNE_RG=(
  --glob '!**/Resources/Sensitive/**'
  --glob '!**/node_modules/**' --glob '!**/.git/**' --glob '!**/.obsidian/**'
  --glob '!**/.planning/**' --glob '!**/.venv/**' --glob '!**/venv/**'
  --glob '!**/__pycache__/**' --glob '!**/.cache/**' --glob '!**/Library/**'
  --glob '!**/*.app/**' --glob '!**/dist/**' --glob '!**/build/**'
  --glob '!**/.claude/**' --glob '!**/worktrees/**'
  # EDIT: add rg globs matching the junk roots you added to PRUNE_FIND above.
  # NOTE (measured): rg honors ONLY floating '**/NAME/**' component globs here —
  # absolute ("!$HOME/...") and multi-component anchored forms ("!**/Desktop/NewBrain/**") are
  # silently ignored, so use single distinctive components. The find -path
  # equivalents in PRUNE_FIND are unaffected (find matches full absolute paths).
  --glob '!**/NewBrain/**'   # the brain's own bytes wholesale: no self-indexing; moc/extracted/ keeps its own dedicated pass in search.sh. EDIT if your clone dir isn't named NewBrain.
)

# --- ARTIFACT IGNORE LIST ---
# Files that would poison search if indexed (e.g. eval/exam files that quote test queries
# verbatim, self-referential plan/diagnosis docs). ONE list, honored by ALL THREE consumers:
#   - search.sh + ingest-root.sh inherit it via the PRUNE_FIND/PRUNE_RG extensions below
#   - build-fts.sh sources canon.sh and calls is_artifact() on every index.tsv row
# Entry shapes: a bare basename matches that filename ANYWHERE on disk; an entry containing "/"
# matches by path suffix (use for generic names where only one instance should be excluded).
# GROW this list whenever a new self-referential artifact is written.
ARTIFACTS=(
  # 'MY-EVAL-QUERIES.md'                   # example: eval file quoting its own test queries
  # 'some-project/SESSION_STATE.md'        # example: path-scoped exclusion
)
# The NewBrain research dir is all plan/diagnosis machinery, never your notes — pruned wholesale
# (is_artifact also short-circuits on it, and the PRUNE extensions below cover the walkers).
is_artifact() {
  local p="$1" b a
  case "$p" in */NewBrain/research/*) return 0;; esac
  b="$(basename "$p")"
  # ${ARTIFACTS[@]+...} guard: empty-array expansion is an unbound-variable error under
  # bash 3.2 (macOS default) when the sourcing script runs with set -u.
  for a in ${ARTIFACTS[@]+"${ARTIFACTS[@]}"}; do
    case "$a" in
      */*) case "$p" in *"$a") return 0;; esac ;;
      *)   [ "$b" = "$a" ] && return 0 ;;
    esac
  done
  return 1
}
for _a in ${ARTIFACTS[@]+"${ARTIFACTS[@]}"}; do
  case "$_a" in
    */*) PRUNE_FIND+=( -not -path "*/$_a" ); PRUNE_RG+=( --glob "!**/$_a" ) ;;
    *)   PRUNE_FIND+=( -not -name "$_a" );   PRUNE_RG+=( --glob "!$_a" ) ;;
  esac
done
unset _a
PRUNE_FIND+=( -not -path '*/NewBrain/research/*' )
PRUNE_RG+=( --glob '!**/NewBrain/research/**' )
