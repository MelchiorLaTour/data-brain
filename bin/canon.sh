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
# A local app adapter may provide an explicit, newline-delimited list of roots that the user
# selected through the host's folder picker. Do not fall back to the defaults when that grant
# file is missing, empty, or stale: that would silently widen scope to the machine's defaults.
nb_is_applications_dir() {
  case "$1" in /Applications|/System/Applications|"$HOME/Applications") return 0 ;; esac
  if [ -n "${DATABRAIN_TEST_APP_DIRS:-}" ]; then
    local dir old_ifs="$IFS"; IFS=:
    for dir in $DATABRAIN_TEST_APP_DIRS; do [ -n "$dir" ] && [ "$1" = "$dir" ] && { IFS="$old_ifs"; return 0; }; done
    IFS="$old_ifs"
  fi
  return 1
}
if [ -n "${NB_CANON_ROOTS_FILE:-}" ]; then
  [ -f "$NB_CANON_ROOTS_FILE" ] || { echo "canon: selected-root grant file is missing" >&2; exit 2; }
  CANON=()
  while IFS= read -r selected_root || [ -n "${selected_root:-}" ]; do
    [ -n "$selected_root" ] || continue
    case "$selected_root" in /*) ;; *) echo "canon: selected roots must be absolute paths" >&2; exit 2 ;; esac
    [ -d "$selected_root" ] && [ ! -L "$selected_root" ] || {
      echo "canon: a selected root is unavailable or is a symbolic link; grant the canonical folder again" >&2
      exit 2
    }
    physical_root="$(cd "$selected_root" 2>/dev/null && pwd -P)" || {
      echo "canon: a selected root is unavailable; grant the canonical folder again" >&2
      exit 2
    }
    [ "$physical_root" = "$selected_root" ] || {
      echo "canon: a selected root now resolves through a symbolic link; grant the canonical folder again" >&2
      exit 2
    }
    case "$selected_root" in
      */Resources/Sensitive|*/Resources/Sensitive/*)
        echo "canon: credential and sensitive roots are blocked" >&2
        exit 2
        ;;
    esac
    # An Applications folder in the grant means "read my apps" (Notes, Reminders: their content sits in the generated app-content folder),
    # never "index the files lying in /Applications". Every walker (index, inventory, prune, freshness) skips it, so they always agree.
    if nb_is_applications_dir "$selected_root"; then continue; fi
    CANON+=("$selected_root")
  done < "$NB_CANON_ROOTS_FILE"
  [ "${#CANON[@]}" -gt 0 ] || { echo "canon: selected-root grant file is empty" >&2; exit 2; }
  VAULT="${CANON[0]}"
fi
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
# Place this expression before the walker's type/name filters. `-prune` prevents find from
# enumerating a forbidden subtree; PRUNE_FIND below only filters emitted paths after descent.
PRUNE_DIRS=(
  \( -type d \( -path '*/Resources/Sensitive' -o -name node_modules -o -name .git \
    -o -name .obsidian -o -name .planning -o -name .venv -o -name venv \
    -o -name '.conda*' -o -name '.venv*' -o -name site-packages -o -name 'DataBrain-ChatGPT-Installer-*' \
    -o -name __pycache__ -o -name .cache -o -name Library -o -name '*.app' \
    -o -name dist -o -name build -o -name .claude -o -name worktrees \
    -o -name .ssh -o -name .gnupg -o -name .aws \
    -o -path "$NB_SELF/moc" -o -path "$NB_SELF/bin" -o -path "$NB_SELF/catalog" \
    -o -path '*/NewBrain/research' \
    -o \( -name moc \( -exec test -e '{}/index.tsv' \; -o -exec test -e '{}/fts.db' \; \) \) \
    -o \( \( -name moc -o -name app-content -o -name .databrain \) -exec test -e '{}/../.databrain/desktop-state.json' \; \) \) -prune \) -o
)
# A DataBrain's own generated folders can sit inside an approved source folder: moc/ (index, extracts, search database, room maps),
# app-content/ (generated mirrors of Notes and Reminders) and .databrain/ (setup state, held file names, app item records). Their contents are
# never indexed or searched: PRUNE_DIRS stops the walk at them, and nb_in_brain_moc answers the same question for a single path. A brain is
# recognised by .databrain/desktop-state.json beside the folder, or (for moc/) by an index.tsv or fts.db inside it. Any other folder with one
# of these names is an ordinary folder.
# Python environment folders (a name starting .conda or .venv, or site-packages) and the unzipped DataBrain installer (DataBrain-ChatGPT-Installer-*) hold program files, never notes. One path: is it inside one?
# Part 26: only files that are not .txt or .md count as ChatGPT's own output. Used by prune-missing.sh so a brain that indexed such files before this rule drops them on its next refresh.
nb_in_python_env() {
  case "$1" in */.conda*/*|*/.venv*/*|*/venv/*|*/site-packages/*|*/DataBrain-ChatGPT-Installer-*/*) return 0 ;; esac
  return 1
}
# ChatGPT writes its own per-chat output (code, scratch files, drafts) into ~/Documents/Codex. That is not the user's notes. The ChatGPT host sets
# DATABRAIN_SKIP_CODEX_OUTPUT=1 for the engine; the Claude host does not (0.1.48 is published and its behaviour stays as shipped). One path: is it inside that folder?
# Used by prune-missing.sh so a brain that indexed such files before this rule drops them on its next refresh.
nb_in_codex_output() {
  [ "${DATABRAIN_SKIP_CODEX_OUTPUT:-}" = 1 ] || return 1
  case "$1" in
    "$HOME/Documents/Codex"/*)
      # part 26: ChatGPT saves the notes it is asked to keep there as .txt or .md, so those two stay indexed; code, images and other scratch stay out
      case "$1" in *.[tT][xX][tT]|*.[mM][dD]) return 1 ;; esac
      return 0 ;;
  esac
  return 1
}
nb_in_brain_moc() {
  local d base
  d="$(dirname -- "$1")"
  while [ "$d" != "/" ] && [ "$d" != "." ] && [ -n "$d" ]; do
    base="$(basename -- "$d")"
    if [ "$base" = moc ] && { [ -e "$d/index.tsv" ] || [ -e "$d/fts.db" ]; }; then return 0; fi
    case "$base" in moc|app-content|.databrain) [ -e "$(dirname -- "$d")/.databrain/desktop-state.json" ] && return 0 ;; esac
    d="$(dirname -- "$d")"
  done
  return 1
}
PRUNE_FIND=(
  -not -path '*/Resources/Sensitive/*'
  -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.obsidian/*'
  -not -path '*/.planning/*' -not -path '*/.venv/*' -not -path '*/venv/*'
  -not -path '*/.conda*/*' -not -path '*/.venv*/*' -not -path '*/site-packages/*' -not -path '*/DataBrain-ChatGPT-Installer-*/*'   # Python environments and the unzipped DataBrain installer: program files, not notes
  -not -path '*/__pycache__/*' -not -path '*/.cache/*' -not -path '*/Library/*'
  -not -path '*.app/*' -not -path '*/dist/*' -not -path '*/build/*'
  -not -path '*/.claude/*' -not -path '*/worktrees/*'         # per-project Claude scaffolding + git worktrees
  -not -path '*/.ssh/*' -not -path '*/.gnupg/*' -not -path '*/.aws/*'   # credentials
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
  --glob '!**/.conda*/**' --glob '!**/.venv*/**' --glob '!**/site-packages/**' --glob '!**/DataBrain-ChatGPT-Installer-*/**'
  --glob '!**/__pycache__/**' --glob '!**/.cache/**' --glob '!**/Library/**'
  --glob '!**/*.app/**' --glob '!**/dist/**' --glob '!**/build/**'
  --glob '!**/.claude/**' --glob '!**/worktrees/**'
  --glob '!**/.ssh/**' --glob '!**/.gnupg/**' --glob '!**/.aws/**'
  # EDIT: add rg globs matching the junk roots you added to PRUNE_FIND above.
  # NOTE (measured): rg honors ONLY floating '**/NAME/**' component globs here —
  # absolute ("!$HOME/...") and multi-component anchored forms ("!**/Desktop/NewBrain/**") are
  # silently ignored, so use single distinctive components. The find -path
  # equivalents in PRUNE_FIND are unaffected (find matches full absolute paths).
  --glob '!**/NewBrain/**'   # the brain's own bytes wholesale: no self-indexing; moc/extracted/ keeps its own dedicated pass in search.sh. EDIT if your clone dir isn't named NewBrain.
)

# Online-only ("dataless") files: stdin = newline-separated paths, stdout = those that live only in a cloud drive (iCloud, OneDrive,
# Google Drive, Dropbox: Apple's File Provider marks them). Indexing never reads them, because reading downloads them. NB_TEST_DATALESS_LIST
# (a file of paths) lets tests simulate them; real detection uses the same flag text as `ls -lO`.
nb_dataless_paths() {
  if [ -n "${NB_TEST_DATALESS_LIST:-}" ]; then /usr/bin/awk 'NR == FNR { want[$0] = 1; next } ($0 in want)' "$NB_TEST_DATALESS_LIST" - 2>/dev/null || true; return 0; fi
  tr '\n' '\0' | xargs -0 stat -f '%Sf%t%N' 2>/dev/null | awk -F'\t' '$1 ~ /dataless/ { print substr($0, length($1) + 2) }'
}

# One file: is it online-only (dataless) right now? Same rule as nb_dataless_paths (NB_TEST_DATALESS_LIST simulates it in tests). A file that was
# indexed and LATER went online-only is never opened, never pruned as missing and never downloaded: its indexed text stays searchable.
nb_is_dataless() {
  if [ -n "${NB_TEST_DATALESS_LIST:-}" ]; then grep -Fxq -- "$1" "$NB_TEST_DATALESS_LIST" 2>/dev/null; return; fi
  stat -f '%Sf' "$1" 2>/dev/null | grep -q dataless
}

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
  b="${p##*/}"
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

is_approved_source_path() {
  local candidate="$1" parent canonical root
  parent="$(cd -P "$(dirname "$candidate")" 2>/dev/null && pwd -P)" || return 1
  canonical="$parent/$(basename "$candidate")"
  [ "$canonical" = "$candidate" ] || return 1
  for root in "${CANON[@]}"; do
    case "$canonical" in "$root"/*) approved_root_identity "$root" >/dev/null && return 0 ;; esac
  done
  return 1
}

# A Desktop grant binds both a canonical path and its filesystem identity. Terminal users do not
# provide this sidecar and keep the historical path-only behavior.
approved_root_identity() {
  local selected_root="$1" identity_root identity current
  if [ -z "${NB_CANON_ROOT_IDENTITIES_FILE:-}" ]; then
    stat -f '%d:%i' "$selected_root" 2>/dev/null
    return $?
  fi
  [ -f "$NB_CANON_ROOT_IDENTITIES_FILE" ] && [ ! -L "$NB_CANON_ROOT_IDENTITIES_FILE" ] || {
    echo 'canon: selected-folder identity grant is missing or unsafe' >&2
    return 1
  }
  while IFS=$'\t' read -r identity_root identity; do
    [ "$identity_root" = "$selected_root" ] || continue
    current="$(stat -f '%d:%i' "$selected_root" 2>/dev/null)" || return 1
    [ "$identity" = "$current" ] || {
      echo 'canon: an approved source folder changed identity; select it again' >&2
      return 1
    }
    printf '%s\n' "$identity"
    return 0
  done < "$NB_CANON_ROOT_IDENTITIES_FILE"
  echo 'canon: selected folder has no recorded filesystem identity' >&2
  return 1
}

# Check an existing or one-level-new destination directory without following a symlink.
is_approved_directory_path() {
  local candidate="$1" parent canonical root
  case "$candidate" in /*) ;; *) return 1 ;; esac
  case "$candidate" in *$'\n'*|*$'\r'*|*$'\t'*) return 1 ;; esac
  if [ -d "$candidate" ]; then
    canonical="$(cd -P "$candidate" 2>/dev/null && pwd -P)" || return 1
    [ "$canonical" = "$candidate" ] || return 1
  else
    parent="$(dirname "$candidate")"
    [ -d "$parent" ] || return 1
    canonical="$(cd -P "$parent" 2>/dev/null && pwd -P)/$(basename "$candidate")" || return 1
    [ "$canonical" = "$candidate" ] || return 1
  fi
  for root in "${CANON[@]}"; do
    case "$canonical" in "$root"|"$root"/*) return 0 ;; esac
  done
  return 1
}

# Accept only regular, non-symlink files whose canonical path remains inside a selected root.
# Index-derived consumers use this before reading source bytes; index.tsv is not authorization.
is_approved_source_file() {
  local candidate="$1"
  is_approved_source_path "$candidate" && [ -f "$candidate" ] && [ ! -L "$candidate" ]
}

# Fingerprint (inode:size:mtime:ctime) of the file open on descriptor 9. On macOS the stat of /dev/fd/9 now and then answers "Bad file descriptor"
# for a moment under load (about 4 in 12,000 with 8 parallel loops; the very next try answered every time, 32 of 32). An empty answer is not a
# changed file, so ask up to 3 times; three empty answers still fail the comparison, as before.
fd9_fingerprint() {
  local out attempt
  for attempt in 1 2 3; do
    out="$(stat -f '%i:%z:%m:%c' /dev/fd/9 2>/dev/null)" && [ -n "$out" ] && { printf '%s' "$out"; return 0; }
  done
  return 1
}

# Copy a canonical regular file through a verified descriptor into a private temporary file.
# Compare path, opened descriptor, and final path fingerprints so a swap cannot publish bytes.
copy_verified_file() {
  local file="$1" destination="$2" before opened after_fd after_path staged
  [ -f "$file" ] && [ ! -L "$file" ] || return 2
  [ "$(cd -P "$(dirname "$file")" 2>/dev/null && pwd -P)/$(basename "$file")" = "$file" ] || return 2
  before="$(stat -f '%i:%z:%m:%c' "$file" 2>/dev/null)" || return 2
  staged="$(mktemp "${TMPDIR:-/tmp}/databrain-verified.XXXXXX")" || return 2
  if ! exec 9<"$file"; then rm -f "$staged"; return 2; fi
  opened="$(fd9_fingerprint || true)"
  if [ "$opened" != "$before" ] || [ -L "$file" ]; then
    exec 9<&-
    rm -f "$staged"
    return 2
  fi
  if ! cat /dev/fd/9 > "$staged"; then
    exec 9<&-
    rm -f "$staged"
    return 2
  fi
  after_fd="$(fd9_fingerprint || true)"
  after_path="$(stat -f '%i:%z:%m:%c' "$file" 2>/dev/null || true)"
  exec 9<&-
  if [ "$opened" != "$after_fd" ] || [ "$opened" != "$after_path" ] || [ -L "$file" ] || \
      [ "$(cd -P "$(dirname "$file")" 2>/dev/null && pwd -P)/$(basename "$file")" != "$file" ]; then
    rm -f "$staged"
    return 2
  fi
  mv -f -- "$staged" "$destination"
}

# Source content can be copied into search only while its selected-root grant still matches.
copy_approved_source() {
  local file="$1" destination="$2"
  is_approved_source_file "$file" || return 2
  copy_verified_file "$file" "$destination" || return 2
  is_approved_source_file "$file" || { rm -f "$destination"; return 2; }
}

# Read only a Markdown file's first frontmatter block from a verified descriptor.
# The path is checked before and after open/read; a replacement or outside symlink
# leaves the caller with no metadata to index.
# 0 when two fingerprints (inode:size:mtime:ctime) differ ONLY in ctime. iCloud moves ctime when a download finishes or a file is
# evicted, with the same inode, size and mtime; any other difference is a real change or swap. read_approved_frontmatter returns 3
# for the ctime-only case so callers may re-read once; 2 stays "changed or unsafe: never index".
nb_fp_ctime_only() {
  local a="$1" b="$2"
  [ -n "$a" ] && [ -n "$b" ] && [ "$a" != "$b" ] && [ "${a%:*}" = "${b%:*}" ]
}

read_approved_frontmatter() {
  local file="$1" tmp before opened after_fd after_path first line count=0 closed=0
  is_approved_source_file "$file" || return 2
  # /dev/fd is mounted on devfs on macOS, so its `%d` device differs from
  # the underlying file even though `%i` and the remaining fingerprint fields match.
  before="$(stat -f '%i:%z:%m:%c' "$file" 2>/dev/null)" || return 2
  [ -n "$before" ] || return 2
  tmp="$(mktemp "${TMPDIR:-/tmp}/databrain-frontmatter.XXXXXX")" || return 2
  if ! exec 9<"$file"; then rm -f "$tmp"; return 2; fi
  opened="$(fd9_fingerprint || true)"
  if [ "$opened" != "$before" ] || ! is_approved_source_file "$file"; then
    exec 9<&-
    rm -f "$tmp"
    nb_fp_ctime_only "$before" "$opened" && is_approved_source_file "$file" && return 3
    return 2
  fi
  IFS= read -r first <&9 || first=''
  if [ "$first" = '---' ]; then
    while IFS= read -r line <&9; do
      if [ "$line" = '---' ]; then closed=1; break; fi
      count=$((count + 1))
      if [ "$count" -gt 200 ]; then break; fi
      printf '%s\n' "$line" >> "$tmp"
    done
  fi
  after_fd="$(fd9_fingerprint || true)"
  after_path="$(stat -f '%i:%z:%m:%c' "$file" 2>/dev/null || true)"
  exec 9<&-
  if [ "$opened" != "$after_fd" ] || [ "$opened" != "$after_path" ] || \
      [ "$closed" -ne 1 ] && [ "$first" = '---' ] || ! is_approved_source_file "$file"; then
    rm -f "$tmp"
    if [ "$opened" != "$after_fd" ] || [ "$opened" != "$after_path" ]; then
      { [ "$opened" = "$after_fd" ] || nb_fp_ctime_only "$opened" "$after_fd"; } && \
        { [ "$opened" = "$after_path" ] || nb_fp_ctime_only "$opened" "$after_path"; } && \
        is_approved_source_file "$file" && return 3
    fi
    # Part 19: the file did NOT change while it was read, its frontmatter simply never closed within the lines read (a long block such as a downloaded
    # model card's metadata, or an opening --- with no closing one). That is a note with no usable tags, not a failure: report no frontmatter. Before this, such a
    # file was left out of every ingest pass forever (the index looked stale again after each refresh) and stopped the full index build (build-index.sh exit 2).
    if [ "$opened" = "$after_fd" ] && [ "$opened" = "$after_path" ] && [ "$closed" -ne 1 ] && [ "$first" = '---' ] && is_approved_source_file "$file"; then
      return 0
    fi
    return 2
  fi
  cat "$tmp"
  rm -f "$tmp"
}

# Emit NUL-delimited absolute paths only if the selected directory still names the same
# filesystem object after traversal. The cwd descriptor keeps a parent rename from redirecting
# the walk; the final identity check prevents publishing paths through a replacement symlink.
selected_root_find0() {
  local selected_root="$1" root_identity
  shift
  case "$selected_root" in *$'\n'*|*$'\r'*|*$'\t'*)
    echo 'selected-root walker: a selected folder path contains a tab or line break and cannot be recorded safely' >&2
    return 2
    ;;
  esac
  root_identity="$(approved_root_identity "$selected_root")" || return 2
  (
    cd "$selected_root" 2>/dev/null || exit 2
    [ "$(stat -f '%d:%i' . 2>/dev/null)" = "$root_identity" ] || exit 2
    set -o pipefail
    find . "$@" -print0 | while IFS= read -r -d '' entry; do
      case "$entry" in *$'\n'*|*$'\r'*|*$'\t'*)
        echo 'selected-root walker: a source file path contains a tab or line break and cannot be recorded safely' >&2
        exit 2
        ;;
      esac
      nb_in_codex_output "$selected_root/${entry#./}" && continue   # ChatGPT's own output folder (ChatGPT host only): the walk sees relative paths, so this is checked on the full one
      printf '%s/%s\0' "$selected_root" "${entry#./}"
    done
    find_status=$?
    [ "$find_status" -eq 0 ] || exit "$find_status"
    [ "$(stat -f '%d:%i' . 2>/dev/null)" = "$root_identity" ] || exit 2
    [ "$(stat -f '%d:%i' "$selected_root" 2>/dev/null)" = "$root_identity" ] || exit 2
  )
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
