#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-frontmatter-race.XXXXXX")"
cleanup() {
  for name in ingest build; do
    local target="$SCRATCH/$name/root/source.md"
    local held="$SCRATCH/$name/source.held"
    rm -f "$target"
    [ ! -f "$held" ] || mv "$held" "$target"
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

run_case() {
  local name="$1" kind="$2"
  local root="$SCRATCH/$name/root" outside="$SCRATCH/$name/outside"
  local moc="$SCRATCH/$name/brain/moc" bin="$SCRATCH/$name/bin"
  local target="$root/source.md" held="$SCRATCH/$name/source.held"
  local roots="$SCRATCH/$name/roots.txt" marker="$SCRATCH/$name/swapped"
  mkdir -p "$root" "$outside" "$moc" "$bin"
  root="$(cd "$root" && pwd -P)"
  target="$root/source.md"
  printf '%s\n' "$root" > "$roots"
  cat > "$target" <<'MD'
---
tags: [approvedfixturekeyword]
---
# Approved source
MD
  cat > "$outside/source.md" <<'MD'
---
tags: [outsidefrontmattersecret]
---
OUTSIDE_SECRET_SENTINEL
MD
  cat > "$bin/find" <<'SH'
#!/bin/bash
set -eu
/usr/bin/find "$@"
status=$?
if [ ! -e "$RACE_MARKER" ]; then
  : > "$RACE_MARKER"
  mv "$RACE_TARGET" "$RACE_HELD"
  ln -s "$RACE_OUTSIDE" "$RACE_TARGET"
fi
exit "$status"
SH
  chmod +x "$bin/find"

  printf '# canonical_path\ttitle\tthemes\tkeywords\n%s\tExisting\t-\tbaseline\n' \
    "$SCRATCH/$name/root/existing.md" > "$moc/index.tsv"
  local before after status=0
  before="$(shasum -a 256 "$moc/index.tsv")"
  if [ "$kind" = ingest ]; then
    if PATH="$bin:/usr/bin:/bin:/usr/sbin:/sbin" NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$roots" \
        RACE_TARGET="$target" RACE_HELD="$held" RACE_OUTSIDE="$outside/source.md" RACE_MARKER="$marker" \
        bash "$PROJECT_ROOT/bin/ingest-root.sh" "$root" > "$SCRATCH/$name/output.log" 2>&1; then
      status=0
    else
      status=$?
    fi
  elif PATH="$bin:/usr/bin:/bin:/usr/sbin:/sbin" NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$roots" \
      RACE_TARGET="$target" RACE_HELD="$held" RACE_OUTSIDE="$outside/source.md" RACE_MARKER="$marker" \
      bash "$PROJECT_ROOT/bin/build-index.sh" > "$SCRATCH/$name/output.log" 2>&1; then
    status=0
  else
    status=$?
  fi
  [ "$status" -ne 0 ] || { cat "$SCRATCH/$name/output.log" >&2; echo "FAIL: $kind accepted a raced source" >&2; exit 1; }
  [ -e "$marker" ] || { echo "FAIL: $kind race was not injected" >&2; exit 1; }
  after="$(shasum -a 256 "$moc/index.tsv")"
  [ "$before" = "$after" ] || { echo "FAIL: $kind changed the prior index after a source race" >&2; exit 1; }
  ! rg -l 'outsidefrontmattersecret|OUTSIDE_SECRET_SENTINEL' "$moc" >/dev/null || {
    echo "FAIL: $kind copied outside source data into generated state" >&2
    exit 1
  }
}

run_case ingest ingest
run_case build build
echo 'PASS: source swaps after enumeration are rejected before frontmatter enters either index; prior indexes remain byte-for-byte unchanged.'
