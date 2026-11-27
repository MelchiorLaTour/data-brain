#!/usr/bin/env bash
# WSL-only launcher. The macOS implementation under bin/ remains unchanged.
set -eu
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHIMS="$ROOT/windows/shims"

usage() {
  echo "usage: bash windows/data-brain-wsl.sh {install|verify|fts|look|search|refresh|recent|extract|rebuild} [arguments]" >&2
  exit 64
}

[ "$#" -gt 0 ] || usage
command="$1"
shift
export PATH="$SHIMS:$PATH"

case "$command" in
  install) exec bash "$ROOT/windows/install-wsl.sh" "$@" ;;
  verify) exec bash "$ROOT/verify-install.sh" "$@" ;;
  fts|look|search|refresh|recent|extract|rebuild) exec bash "$ROOT/bin/$command.sh" "$@" ;;
  *) usage ;;
esac
