#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$ROOT/setup/mcp/manifest.json"
OUT_DIR="${DATABRAIN_PACKAGING_OUT_DIR:-$ROOT/setup/packaging}"
OUT="$OUT_DIR/databrain.mcpb"
BUILDINFO_OUT="$OUT_DIR/databrain.buildinfo.txt"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/databrain-mcpb.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

[ -f "$MANIFEST" ] || { echo "build: missing $MANIFEST" >&2; exit 2; }
python3 -m json.tool "$MANIFEST" >/dev/null
command -v zip >/dev/null 2>&1 || { echo 'build: zip is required' >&2; exit 2; }

mkdir -p "$STAGE/bin" "$STAGE/setup/mcp"
cp "$MANIFEST" "$STAGE/manifest.json"
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
# Package only the shared-engine scripts called by the MCP server and their shared helper.
# In particular, do not copy corpus-derived dictionaries or other repository content.
ENGINE_BIN_FILES=(
  build-fts.sh
  build-index.sh
  canon.sh
  extract.sh
  fts.sh
  index-add.sh
  ingest-root.sh
  inventory.sh
  look.sh
  relationships.sh
  rebuild.sh
  refresh.sh
  taxonomy.sh
  prune-missing.sh
)
for file in "${ENGINE_BIN_FILES[@]}"; do
  [ -f "$ROOT/bin/$file" ] || { echo "build: missing required engine script bin/$file" >&2; exit 2; }
  cp "$ROOT/bin/$file" "$STAGE/bin/$file"
done
cp "$ROOT/setup/mcp/server.mjs" "$ROOT/setup/mcp/relationship-core.mjs" "$ROOT/setup/mcp/taxonomy-core.mjs" "$ROOT/setup/mcp/freshness-core.mjs" "$ROOT/setup/mcp/github-release-check.mjs" "$ROOT/setup/mcp/codex-state.mjs" "$ROOT/setup/mcp/package-identity.mjs" "$ROOT/setup/mcp/folder-picker.js" "$ROOT/setup/mcp/pdf-extract.js" "$STAGE/setup/mcp/"

engine_revision="$(git -C "$ROOT" rev-parse HEAD)"
engine_repository="$(git -C "$ROOT" remote get-url origin)"
[ "$engine_repository" = 'https://github.com/MelchiorLaTour/data-brain.git' ] || {
  echo "build: unexpected origin repository: $engine_repository" >&2
  exit 2
}
source_digest="$(find "$STAGE" -type f -print | LC_ALL=C sort | while IFS= read -r file; do relative="${file#"$STAGE"/}"; (cd "$STAGE" && shasum -a 256 "$relative"); done | shasum -a 256 | awk '{print $1}')"
if [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=all)" ]; then
  tree_status=clean
else
  tree_status=dirty
fi
printf 'engine_repository=%s\nengine_revision=%s\nsource_tree=%s\nsource_sha256=%s\n' "$engine_repository" "$engine_revision" "$tree_status" "$source_digest" > "$STAGE/BUILDINFO.txt"
mkdir -p "$OUT_DIR"
cp "$STAGE/BUILDINFO.txt" "$BUILDINFO_OUT"

# Fixed timestamps and sorted file order make identical source trees produce identical archives.
find "$STAGE" -type f -exec touch -t 198001010000 {} +
rm -f "$OUT"
(cd "$STAGE" && find . -type f -print | LC_ALL=C sort | zip -X -D -0 "$OUT" -@ >/dev/null)
(cd "$(dirname "$OUT")" && shasum -a 256 "$(basename "$OUT")") > "$OUT.sha256"
echo "Built $OUT"
cat "$OUT.sha256"
