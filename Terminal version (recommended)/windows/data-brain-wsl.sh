#!/usr/bin/env bash
# WSL launcher. bin/ scripts handle Linux themselves (bin/compat.sh); this is a convenience entry point.
set -eu
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "usage: bash windows/data-brain-wsl.sh {install|verify|fts|look|search|refresh|recent|extract|rebuild} [arguments]" >&2
  exit 64
}

[ "$#" -gt 0 ] || usage
command="$1"
shift

case "$command" in
  install) exec bash "$ROOT/windows/install-wsl.sh" "$@" ;;
  verify) exec bash "$ROOT/verify-install.sh" "$@" ;;
  fts|look|search|refresh|recent|extract|rebuild) exec bash "$ROOT/bin/$command.sh" "$@" ;;
  *) usage ;;
esac
