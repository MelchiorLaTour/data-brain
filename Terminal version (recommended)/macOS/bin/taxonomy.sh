#!/usr/bin/env bash
# Propose folder categories from index metadata, or apply already-confirmed assignments.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOC="${NB_MOC_DIR:-$ROOT/moc}"
CORE="$ROOT/setup/mcp/taxonomy-core.mjs"

[ -n "${NB_CANON_ROOTS_FILE:-}" ] || { echo 'taxonomy: NB_CANON_ROOTS_FILE must point to the selected-folder grant' >&2; exit 2; }
[ -s "$MOC/index.tsv" ] || { echo "taxonomy: missing or empty $MOC/index.tsv" >&2; exit 2; }
[ "$#" -gt 0 ] || { echo 'usage: taxonomy.sh propose | taxonomy.sh apply FOLDER=category[,category] ...' >&2; exit 2; }

command="$1"
shift
if [ "$command" = propose ]; then
  [ "$#" -eq 0 ] || { echo 'usage: taxonomy.sh propose' >&2; exit 2; }
  node "$CORE" propose "$MOC/index.tsv" "$NB_CANON_ROOTS_FILE"
  exit $?
fi
[ "$command" = apply ] && [ "$#" -gt 0 ] || { echo 'usage: taxonomy.sh apply FOLDER=category[,category] ...' >&2; exit 2; }
node "$CORE" apply "$MOC/index.tsv" "$NB_CANON_ROOTS_FILE" "$@"
NB_MOC_DIR="$MOC" "$ROOT/bin/rebuild.sh"
NB_MOC_DIR="$MOC" "$ROOT/bin/build-fts.sh"
