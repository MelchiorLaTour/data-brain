#!/usr/bin/env bash
# WSL-only bootstrap: checks WSL dependencies, then runs the shared installer.
set -eu
# The engine is shared with macOS and lives in ../macOS.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../macOS" && pwd)"

if ! grep -qi microsoft /proc/version 2>/dev/null; then
  echo "This launcher is for WSL 2. Run it from an Ubuntu/WSL terminal." >&2
  exit 2
fi

missing=0
for tool in bash python3 rg sqlite3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "MISSING: $tool" >&2; missing=1; }
done
[ "$missing" -eq 0 ] || { echo "Install WSL dependencies (see Windows/README.md), then re-run this command." >&2; exit 1; }
for tool in pandoc pdftotext jq; do
  command -v "$tool" >/dev/null 2>&1 || echo "note: $tool missing. Without it Word/PDF text or the startup hook is skipped: sudo apt install -y pandoc poppler-utils jq"
done
sqlite3 :memory: "CREATE VIRTUAL TABLE t USING fts5(x);" >/dev/null 2>&1 || {
  echo "sqlite3 is present but lacks FTS5 support." >&2
  exit 1
}
exec bash "$ROOT/install.sh"
