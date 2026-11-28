#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-extract-race.XXXXXX")"
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT

run_case() {
  local name="$1" race="$2"
  local root="$SCRATCH/$name/root" outside="$SCRATCH/$name/outside"
  local moc="$SCRATCH/$name/brain/moc" target="$SCRATCH/$name/root/source.pdf"
  local held="$SCRATCH/$name/source.held" bin="$SCRATCH/$name/bin"
  mkdir -p "$root" "$outside" "$moc" "$bin"
  root="$(cd "$root" && pwd -P)"
  target="$root/source.pdf"
  mkdir -p "$moc/extracted"
  printf '%s\n' "$root" > "$SCRATCH/$name/roots.txt"
  printf 'approved source body\n' > "$target"
  printf 'OUTSIDE_SECRET_SENTINEL\n' > "$outside/source.pdf"
  printf '%s\tRace fixture\t-\t-\n' "$target" > "$moc/index.tsv"
  local hash="$(printf '%s' "$target" | shasum | cut -c1-16)"
  local sidecar="$moc/extracted/$hash.txt"
  printf 'preserve last usable extract\n' > "$sidecar"
  cat > "$bin/pdftotext" <<'SH'
#!/bin/sh
/bin/cat "$2"
SH
  chmod +x "$bin/pdftotext"
  if [ "$race" = before-open ]; then
    cat > "$bin/stat" <<'SH'
#!/bin/bash
set -eu
/usr/bin/stat "$@"
for arg in "$@"; do
  if [ "$arg" = "$RACE_TARGET" ] && [ ! -e "$RACE_MARKER" ]; then
    : > "$RACE_MARKER"
    mv "$RACE_TARGET" "$RACE_HELD"
    ln -s "$RACE_OUTSIDE" "$RACE_TARGET"
    break
  fi
done
SH
  else
    cat > "$bin/cat" <<'SH'
#!/bin/bash
set -eu
if [ "${1:-}" = /dev/fd/9 ] && [ ! -e "$RACE_MARKER" ]; then
  : > "$RACE_MARKER"
  mv "$RACE_TARGET" "$RACE_HELD"
  ln -s "$RACE_OUTSIDE" "$RACE_TARGET"
fi
exec /bin/cat "$@"
SH
  fi
  chmod +x "$bin/stat" 2>/dev/null || true
  chmod +x "$bin/cat" 2>/dev/null || true

  if ! PATH="$bin:/usr/bin:/bin" NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/$name/roots.txt" RACE_TARGET="$target" \
      RACE_MARKER="$SCRATCH/$name/triggered" RACE_HELD="$held" \
      RACE_OUTSIDE="$outside/source.pdf" bash "$PROJECT_ROOT/bin/extract.sh" \
      > "$SCRATCH/$name/output.log" 2>&1; then
    cat "$SCRATCH/$name/output.log" >&2
    echo "FAIL: $name extraction aborted instead of reporting the rejected source" >&2
    exit 1
  fi
  [ -e "$SCRATCH/$name/triggered" ] || {
    cat "$SCRATCH/$name/output.log" >&2
    echo "FAIL: $name race was not injected" >&2
    exit 1
  }
  case "$race" in
    before-open) grep -F "$target"$'\tsource_changed_before_open' "$moc/extract-report.tsv" >/dev/null ;;
    after-open) grep -F "$target"$'\tsource_changed_during_copy' "$moc/extract-report.tsv" >/dev/null ;;
  esac || { echo "FAIL: $name race was not recorded as a rejected source" >&2; exit 1; }
  ! rg -l 'OUTSIDE_SECRET_SENTINEL' "$moc" >/dev/null || {
    echo "FAIL: $name outside bytes entered DataBrain state" >&2
    exit 1
  }
  [ "$(cat "$sidecar")" = 'preserve last usable extract' ] || {
    echo "FAIL: $name race discarded the prior usable extract" >&2
    exit 1
  }
  rm "$target"
  mv "$held" "$target"
}

run_case before-open before-open
run_case after-open after-open
echo 'PASS: extraction rejects source swaps before open and after descriptor open, preserves the prior extract, and does not index outside bytes.'
