#!/bin/bash
# Build the DataBrain for ChatGPT installer: DataBrain-ChatGPT-Installer-<version>.zip, its sha256 and a buildinfo.
# One zip holds "Install DataBrain for ChatGPT.command" and everything it installs (engine + the official Node), so nothing else is downloaded.
#
#   DATABRAIN_NODE_TGZ            optional: a local copy of the official Node tarball (default: downloaded from nodejs.org)
#   DATABRAIN_PACKAGING_OUT_DIR   where the zip goes (default: ~/Downloads)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="$(tr -d '[:space:]' < "$ROOT/setup/chatgpt/VERSION")"
NAME="DataBrain-ChatGPT-Installer-$VERSION"
OUT_DIR="${DATABRAIN_PACKAGING_OUT_DIR:-$HOME/Downloads}"
OUT="$OUT_DIR/$NAME.zip"
BUILDINFO_OUT="$OUT_DIR/$NAME.buildinfo.txt"

NODE_VERSION=24.22.2
NODE_TGZ_URL="https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz"
NODE_TGZ_SHA256=aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a
NODE_BIN_SHA256=b6fb419f0f43bb2fbca273700294dd2f3b685a64b60e8417c295f47646a70e4a

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "build: bad version '$VERSION'" >&2; exit 2; }
command -v zip >/dev/null 2>&1 || { echo 'build: zip is required' >&2; exit 2; }
WORK="$(mktemp -d "${TMPDIR:-/tmp}/databrain-chatgpt-build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# The official Node, unmodified: checked against the published tarball checksum, and the extracted program against its own.
TGZ="${DATABRAIN_NODE_TGZ:-}"
if [ -z "$TGZ" ]; then
  TGZ="$WORK/node.tgz"
  curl -fsSL "$NODE_TGZ_URL" -o "$TGZ"
fi
[ "$(shasum -a 256 "$TGZ" | awk '{print $1}')" = "$NODE_TGZ_SHA256" ] || { echo "build: the Node tarball does not match sha256 $NODE_TGZ_SHA256" >&2; exit 2; }
mkdir -p "$WORK/node-x"
tar -xzf "$TGZ" -C "$WORK/node-x"
NODE_DIR="$WORK/node-x/node-v$NODE_VERSION-darwin-arm64"
[ "$(shasum -a 256 "$NODE_DIR/bin/node" | awk '{print $1}')" = "$NODE_BIN_SHA256" ] || { echo 'build: the node program does not match its expected sha256' >&2; exit 2; }

TOP="$WORK/$NAME"
PAYLOAD="$TOP/payload"
mkdir -p "$PAYLOAD/bin" "$PAYLOAD/setup/mcp/hosts" "$PAYLOAD/setup/chatgpt" "$PAYLOAD/node/bin"
cp "$ROOT/../LICENSE" "$PAYLOAD/LICENSE"
# Only the engine scripts the server calls, as in the Claude package: no corpus-derived dictionaries or other repository content.
ENGINE_BIN_FILES=(
  build-fts.sh build-fts-fr.sh build-index.sh canon.sh extract.sh fts.sh index-add.sh ingest-root.sh inventory.sh look.sh
  relationships.sh rebuild.sh refresh.sh taxonomy.sh prune-missing.sh privacy.pl privacy-names.sh cloud-scan.sh name-only.sh
)
for file in "${ENGINE_BIN_FILES[@]}"; do
  [ -f "$ROOT/bin/$file" ] || { echo "build: missing required engine script bin/$file" >&2; exit 2; }
  cp "$ROOT/bin/$file" "$PAYLOAD/bin/$file"
done
for file in server.mjs relationship-core.mjs taxonomy-core.mjs freshness-core.mjs github-release-check.mjs codex-state.mjs package-identity.mjs pdf-extract.js app-readers.mjs app-policy.mjs test-hooks.mjs; do
  cp "$ROOT/setup/mcp/$file" "$PAYLOAD/setup/mcp/$file"
done
cp "$ROOT/setup/mcp/hosts/chatgpt.mjs" "$PAYLOAD/setup/mcp/hosts/chatgpt.mjs"
cp "$ROOT/setup/chatgpt/VERSION" "$PAYLOAD/setup/chatgpt/VERSION"
cp "$ROOT/setup/chatgpt/always-on-rule.sh" "$PAYLOAD/setup/chatgpt/always-on-rule.sh"
cp "$ROOT/setup/chatgpt/always-on-rule.txt" "$PAYLOAD/setup/chatgpt/always-on-rule.txt"
chmod 755 "$PAYLOAD/setup/chatgpt/always-on-rule.sh"
mkdir -p "$PAYLOAD/setup/chatgpt/skills/databrain-save-note"
cp "$ROOT/setup/chatgpt/skills/databrain-save-note/SKILL.md" "$PAYLOAD/setup/chatgpt/skills/databrain-save-note/SKILL.md"
cp "$NODE_DIR/bin/node" "$PAYLOAD/node/bin/node"
cp "$NODE_DIR/LICENSE" "$PAYLOAD/node/LICENSE"
chmod 755 "$PAYLOAD/node/bin/node"

engine_revision="$(git -C "$ROOT" rev-parse HEAD)"
engine_repository="$(git -C "$ROOT" remote get-url origin)"
[ "$engine_repository" = 'https://github.com/MelchiorLaTour/data-brain.git' ] || { echo "build: unexpected origin repository: $engine_repository" >&2; exit 2; }
# The payload digest: sha256 of "<file sha256>  <path>" lines, sorted, for every file except BUILDINFO.txt (the same rule the server's verify check uses).
source_digest="$(cd "$PAYLOAD" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r file; do shasum -a 256 "$file"; done | shasum -a 256 | awk '{print $1}')"
if [ -z "$(git -C "$ROOT" status --porcelain --untracked-files=all)" ]; then tree_status=clean; else tree_status=dirty; fi
printf 'engine_repository=%s\nengine_revision=%s\nsource_tree=%s\nsource_sha256=%s\npackage_kind=chatgpt\npackage_version=%s\narchitecture=darwin-arm64\nruntime_version=%s\n' \
  "$engine_repository" "$engine_revision" "$tree_status" "$source_digest" "$VERSION" "$NODE_VERSION" > "$PAYLOAD/BUILDINFO.txt"

# The installer checks every file against this list before it changes anything.
(cd "$PAYLOAD" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r file; do shasum -a 256 "$file"; done) > "$TOP/PAYLOAD.sha256"
cp "$ROOT/setup/chatgpt/Install DataBrain for ChatGPT.command" "$TOP/Install DataBrain for ChatGPT.command"
chmod 755 "$TOP/Install DataBrain for ChatGPT.command"
cp "$ROOT/setup/chatgpt/Uninstall DataBrain for ChatGPT.command" "$TOP/Uninstall DataBrain for ChatGPT.command"
chmod 755 "$TOP/Uninstall DataBrain for ChatGPT.command"

mkdir -p "$OUT_DIR"
cp "$PAYLOAD/BUILDINFO.txt" "$BUILDINFO_OUT"
# Fixed timestamps and sorted order: the same source gives the same archive.
find "$TOP" -exec touch -t 198001010000 {} +
rm -f "$OUT"
(cd "$WORK" && find "$NAME" -type f -print | LC_ALL=C sort | zip -X -9 "$OUT" -@ >/dev/null)
(cd "$OUT_DIR" && shasum -a 256 "$NAME.zip") > "$OUT.sha256"
echo "Built $OUT"
cat "$OUT.sha256"
echo "Buildinfo: $BUILDINFO_OUT (source_tree=$tree_status, payload sha256 $source_digest)"

# Boot test of the package as it will be installed: unzip it, start the server on its own Node in an empty fake home.
CHECK="$WORK/boot-check"
mkdir -p "$CHECK/home"
unzip -q "$OUT" -d "$CHECK"
HOME="$CHECK/home" "$CHECK/$NAME/payload/node/bin/node" "$ROOT/setup/chatgpt/boot-check.mjs" "$CHECK/$NAME/payload"
