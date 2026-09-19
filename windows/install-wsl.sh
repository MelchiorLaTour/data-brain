#!/usr/bin/env bash
# WSL-only bootstrap. It delegates to the existing installer through shims.
set -eu
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$ROOT/windows/shims:$PATH"

if ! grep -qi microsoft /proc/version 2>/dev/null; then
  echo "This launcher is for WSL 2. Run it from an Ubuntu/WSL terminal." >&2
  exit 2
fi

missing=0
for tool in bash python3 rg sqlite3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "MISSING: $tool" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || { echo "Install WSL dependencies, then re-run this command." >&2; exit 1; }
sqlite3 :memory: "CREATE VIRTUAL TABLE t USING fts5(x);" >/dev/null 2>&1 || {
  echo "sqlite3 is present but lacks FTS5 support." >&2
  exit 1
}
exec bash "$ROOT/install.sh" "$@"
