#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
LOCK="$HERE/runtime-lock.tsv"
VERSION_FILE="$HERE/VERSION"
ARCH=''
OUT_DIR="$HERE/dist"
CACHE=''

usage() {
  echo 'Usage: setup/codex/build.sh --arch darwin-arm64|darwin-x64 [--out DIR] [--cache DIR]' >&2
  exit 2
}
while (($#)); do
  case "$1" in
    --arch) ARCH="${2:-}"; shift 2 ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    --cache) CACHE="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ "$ARCH" == darwin-arm64 || "$ARCH" == darwin-x64 ]] || usage
[[ -f "$LOCK" && -f "$VERSION_FILE" ]] || { echo 'build: runtime lock or package version is missing' >&2; exit 2; }
PACKAGE_VERSION="$(tr -d '\r\n' < "$VERSION_FILE")"
[[ "$PACKAGE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'build: invalid package version' >&2; exit 2; }
for command in awk curl file find grep mkdir mv plutil sed shasum sort tar touch zip; do
  command -v "$command" >/dev/null 2>&1 || { echo "build: required build command is missing: $command" >&2; exit 2; }
done

OUT_DIR="$(mkdir -p "$OUT_DIR" && cd "$OUT_DIR" && pwd -P)"
ARCH_DIR="$OUT_DIR/$ARCH"
mkdir -p "$ARCH_DIR"
BUNDLE_NAME='DataBrain MCP.app'
APP="$ARCH_DIR/$BUNDLE_NAME"
STEM="databrain-codex-$PACKAGE_VERSION-$ARCH"
ZIP="$OUT_DIR/$STEM.zip"
BUILDINFO_OUT="$OUT_DIR/$STEM.buildinfo.txt"
if [[ -e "$APP" || -e "$ZIP" || -e "$ZIP.sha256" || -e "$BUILDINFO_OUT" ]]; then
  echo 'build: an output already exists; choose a fresh --out directory to preserve it' >&2
  exit 2
fi

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/databrain-codex-build.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT
CONTENTS="$STAGE/$BUNDLE_NAME/Contents"
RESOURCES="$CONTENTS/Resources"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Frameworks/node/bin" "$RESOURCES/bin" "$RESOURCES/setup/mcp" "$RESOURCES/runtime/bin"

lock_field() {
  awk -F '\t' -v arch="$ARCH" -v component="$1" '$1 == arch && $2 == component { print; found=1 } END { if (!found) exit 1 }' "$LOCK"
}

fetch_locked() {
  local component="$1" row version url checksum top executable licenses archive unpacked
  row="$(lock_field "$component")" || { echo "build: no $component lock entry for $ARCH" >&2; exit 2; }
  IFS=$'\t' read -r _ _ version url checksum top executable licenses <<< "$row"
  [[ "$checksum" =~ ^[0-9a-f]{64}$ ]] || { echo "build: invalid $component SHA-256 lock" >&2; exit 2; }
  case "$component:$ARCH:$url" in
    node:darwin-arm64:https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz) ;;
    node:darwin-x64:https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-x64.tar.gz) ;;
    rg:darwin-arm64:https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin.tar.gz) ;;
    rg:darwin-x64:https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-apple-darwin.tar.gz) ;;
    *) echo "build: URL is not an approved pinned release for $component/$ARCH" >&2; exit 2 ;;
  esac
  archive="$(basename "$url")"
  local archive_path="$STAGE/$archive"
  if [[ -n "$CACHE" && -f "$CACHE/$archive" ]]; then
    archive_path="$CACHE/$archive"
  else
    echo "build: downloading pinned $component $version for $ARCH" >&2
    curl --fail --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 240 "$url" -o "$archive_path"
  fi
  printf '%s  %s\n' "$checksum" "$archive_path" | shasum -a 256 -c - >/dev/null || {
    echo "build: pinned $component archive failed its SHA-256 check" >&2
    exit 2
  }
  unpacked="$STAGE/unpacked-$component"
  mkdir -p "$unpacked"
  tar -xzf "$archive_path" -C "$unpacked"
  [[ -x "$unpacked/$top/$executable" ]] || { echo "build: pinned $component executable is missing" >&2; exit 2; }
  if [[ "$component" == node ]]; then
    cp "$unpacked/$top/$executable" "$CONTENTS/Frameworks/node/bin/node"
    cp "$unpacked/$top/LICENSE" "$RESOURCES/runtime-LICENSE.node.txt"
    NODE_VERSION="$version"
  else
    cp "$unpacked/$top/$executable" "$RESOURCES/runtime/bin/rg"
    IFS=',' read -r -a license_files <<< "$licenses"
    {
      echo "ripgrep $version license files"
      echo
      for license_file in "${license_files[@]}"; do
        [[ -f "$unpacked/$top/$license_file" ]] || { echo "build: missing ripgrep license file $license_file" >&2; exit 2; }
        echo "===== $license_file ====="
        cat "$unpacked/$top/$license_file"
        echo
      done
    } > "$RESOURCES/runtime-LICENSE.ripgrep.txt"
    RG_VERSION="$version"
  fi
}

fetch_locked node
fetch_locked rg
cp "$ROOT/LICENSE" "$RESOURCES/LICENSE"
cp "$HERE/launch.sh" "$CONTENTS/MacOS/databrain-mcp"
cp "$ROOT/setup/mcp/server.mjs" "$ROOT/setup/mcp/relationship-core.mjs" "$ROOT/setup/mcp/taxonomy-core.mjs" "$ROOT/setup/mcp/freshness-core.mjs" "$ROOT/setup/mcp/github-release-check.mjs" "$ROOT/setup/mcp/codex-state.mjs" "$ROOT/setup/mcp/package-identity.mjs" "$ROOT/setup/mcp/folder-picker.js" "$ROOT/setup/mcp/pdf-extract.js" "$RESOURCES/setup/mcp/"
cp "$ROOT/bin/build-fts.sh" "$ROOT/bin/build-index.sh" "$ROOT/bin/canon.sh" "$ROOT/bin/extract.sh" "$ROOT/bin/fts.sh" "$ROOT/bin/index-add.sh" "$ROOT/bin/ingest-root.sh" "$ROOT/bin/inventory.sh" "$ROOT/bin/look.sh" "$ROOT/bin/relationships.sh" "$ROOT/bin/rebuild.sh" "$ROOT/bin/refresh.sh" "$ROOT/bin/search.sh" "$ROOT/bin/taxonomy.sh" "$RESOURCES/bin/"
chmod 755 "$CONTENTS/MacOS/databrain-mcp" "$CONTENTS/Frameworks/node/bin/node" "$RESOURCES/runtime/bin/rg"

# ChatGPT desktop requires macOS 14; pinned Node v24.21.0 declares 13.5.0.
MIN_MACOS='14.0'
sed -e "s/@VERSION@/$PACKAGE_VERSION/g" -e "s/@MIN_MACOS@/$MIN_MACOS/g" "$HERE/Info.plist.in" > "$CONTENTS/Info.plist"
plutil -lint "$CONTENTS/Info.plist" >/dev/null

cat > "$RESOURCES/PACKAGE.tsv" <<EOF
kind=codex
version=$PACKAGE_VERSION
architecture=$ARCH
runtime_version=$NODE_VERSION
rg_version=$RG_VERSION
minimum_macos=$MIN_MACOS
EOF

ENGINE_REPOSITORY="$(git -C "$ROOT" remote get-url origin)"
[[ "$ENGINE_REPOSITORY" == https://github.com/MelchiorLaTour/data-brain.git ]] || {
  echo "build: unexpected canonical repository: $ENGINE_REPOSITORY" >&2
  exit 2
}
ENGINE_REVISION="$(git -C "$ROOT" rev-parse HEAD)"
[[ "$ENGINE_REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo 'build: invalid source revision' >&2; exit 2; }
if [[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=all)" ]]; then SOURCE_TREE=clean; else SOURCE_TREE=dirty; fi

source_records=''
while IFS= read -r file; do
  relative="${file#"$CONTENTS/"}"
  digest="$(shasum -a 256 "$file" | awk '{print $1}')"
  source_records+="$digest  $relative"$'\n'
done < <(find "$RESOURCES/bin" "$RESOURCES/setup/mcp" -type f -print | LC_ALL=C sort)
SOURCE_SHA256="$(printf '%s' "$source_records" | shasum -a 256 | awk '{print $1}')"
cat > "$RESOURCES/BUILDINFO.txt" <<EOF
package_kind=codex
package_version=$PACKAGE_VERSION
architecture=$ARCH
runtime_version=$NODE_VERSION
rg_version=$RG_VERSION
minimum_macos=$MIN_MACOS
engine_repository=$ENGINE_REPOSITORY
engine_revision=$ENGINE_REVISION
source_tree=$SOURCE_TREE
source_sha256=$SOURCE_SHA256
EOF

if find "$CONTENTS" -type l -print | grep -q .; then
  echo 'build: symbolic links are not allowed in the app bundle' >&2
  exit 2
fi
while IFS= read -r file; do
  relative="${file#"$CONTENTS/"}"
  digest="$(shasum -a 256 "$file" | awk '{print $1}')"
  printf '%s  %s\n' "$digest" "$relative"
done < <(find "$CONTENTS" -type f ! -path '*/_CodeSignature/*' ! -name CodeResources ! -path "$RESOURCES/PAYLOAD.sha256" -print | LC_ALL=C sort) > "$RESOURCES/PAYLOAD.sha256"

NODE_MACHINE="$(file "$CONTENTS/Frameworks/node/bin/node")"
RG_MACHINE="$(file "$RESOURCES/runtime/bin/rg")"
case "$ARCH:$NODE_MACHINE:$RG_MACHINE" in
  darwin-arm64:*arm64*:*arm64*) ;;
  darwin-x64:*x86_64*:*x86_64*) ;;
  *) echo "build: runtime architecture does not match $ARCH" >&2; exit 2 ;;
esac
case "$(uname -m)" in
  arm64) HOST_ARCH=darwin-arm64 ;;
  x86_64) HOST_ARCH=darwin-x64 ;;
  *) HOST_ARCH=unsupported ;;
esac
if [[ "$ARCH" == "$HOST_ARCH" ]]; then
  [[ "$("$CONTENTS/Frameworks/node/bin/node" --version)" == "v$NODE_VERSION" ]] || { echo 'build: bundled Node version did not execute as pinned' >&2; exit 2; }
  [[ "$("$RESOURCES/runtime/bin/rg" --version | head -n 1)" == "ripgrep $RG_VERSION "* ]] || { echo 'build: bundled ripgrep version did not execute as pinned' >&2; exit 2; }
fi

find "$CONTENTS" -type f -exec touch -t 198001010000 {} +
mkdir -p "$OUT_DIR"
ZIP_TMP="$STAGE/$STEM.zip"
(cd "$STAGE" && zip -X -q -r "$ZIP_TMP" "$BUNDLE_NAME")
mkdir -p "$ARCH_DIR"
cp "$RESOURCES/BUILDINFO.txt" "$BUILDINFO_OUT"
mv "$STAGE/$BUNDLE_NAME" "$APP"
mv "$ZIP_TMP" "$ZIP"
(cd "$OUT_DIR" && shasum -a 256 "$STEM.zip") > "$ZIP.sha256.tmp"
mv "$ZIP.sha256.tmp" "$ZIP.sha256"
echo "Built unsigned local candidate: $APP" >&2
echo "Release-shaped archive: $ZIP" >&2
