#!/usr/bin/env bash
# WSL launcher. bin/ scripts handle Linux themselves (bin/compat.sh); this is a convenience entry point.
set -eu
# The engine is shared with macOS and lives in ../macOS.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../macOS" && pwd)"

usage() {
  echo "usage: bash Windows/data-brain-wsl.sh {install|verify|fts|look|search|refresh|recent|extract|rebuild} [arguments]" >&2
  exit 64
}

[ "$#" -gt 0 ] || usage
command="$1"
shift

case "$command" in
  install) exec bash "$(dirname "${BASH_SOURCE[0]}")/install-wsl.sh" "$@" ;;
  verify) exec bash "$ROOT/verify-install.sh" "$@" ;;
  fts|look|search|refresh|recent|extract|rebuild) exec bash "$ROOT/bin/$command.sh" "$@" ;;
  *) usage ;;
esac
