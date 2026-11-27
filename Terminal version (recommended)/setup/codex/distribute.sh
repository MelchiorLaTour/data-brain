#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
APP_INPUT=''
OUT_INPUT=''
IDENTITY=''
KEYCHAIN_PROFILE=''

usage() {
  echo 'Usage: setup/codex/distribute.sh --app UNSIGNED_APP --out NEW_DIR --identity DEVELOPER_ID --keychain-profile PROFILE' >&2
  exit 2
}
while (($#)); do
  case "$1" in
    --app) APP_INPUT="${2:-}"; shift 2 ;;
    --out) OUT_INPUT="${2:-}"; shift 2 ;;
    --identity) IDENTITY="${2:-}"; shift 2 ;;
    --keychain-profile) KEYCHAIN_PROFILE="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$APP_INPUT" && -n "$OUT_INPUT" && -n "$IDENTITY" && -n "$KEYCHAIN_PROFILE" ]] || usage
[[ "$IDENTITY" != -* ]] || { echo 'distribute: the signing identity must be a Developer ID Application name' >&2; exit 2; }
[[ "$(uname -s)" == Darwin ]] || { echo 'distribute: macOS is required for signing and Gatekeeper checks' >&2; exit 2; }

for command in codesign ditto find git node security shasum spctl xcrun; do
  command -v "$command" >/dev/null 2>&1 || { echo "distribute: required command is missing: $command" >&2; exit 2; }
done
xcrun --find notarytool >/dev/null 2>&1 || { echo 'distribute: the active Xcode installation does not provide notarytool' >&2; exit 2; }
xcrun --find stapler >/dev/null 2>&1 || { echo 'distribute: the active Xcode installation does not provide stapler' >&2; exit 2; }
IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null)" || {
  echo 'distribute: could not inspect the available code-signing identities' >&2
  exit 2
}
if ! printf '%s\n' "$IDENTITIES" | awk -v identity="\"$IDENTITY\"" 'index($0, identity) && index($0, "Developer ID Application:") { found=1 } END { exit !found }'; then
  echo 'distribute: the requested Developer ID Application identity is not available in the Keychain' >&2
  exit 2
fi

APP_PARENT="$(cd "$(dirname "$APP_INPUT")" && pwd -P)"
APP_SOURCE="$APP_PARENT/$(basename "$APP_INPUT")"
[[ -d "$APP_SOURCE" && ! -L "$APP_SOURCE" && "$APP_SOURCE" == *.app ]] || {
  echo 'distribute: --app must name an existing, non-symlink .app bundle' >&2
  exit 2
}
[[ -x "$APP_SOURCE/Contents/Frameworks/node/bin/node" && -x "$APP_SOURCE/Contents/Resources/runtime/bin/rg" ]] || {
  echo 'distribute: the app bundle is missing a bundled runtime' >&2
  exit 2
}

OUT_PARENT="$(cd "$(dirname "$OUT_INPUT")" && pwd -P)"
OUT_DIR="$OUT_PARENT/$(basename "$OUT_INPUT")"
[[ ! -e "$OUT_DIR" ]] || { echo 'distribute: --out already exists; choose a new directory to preserve it' >&2; exit 2; }

SOURCE_REVISION="$(git -C "$ROOT" rev-parse HEAD)"
[[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=all)" ]] || {
  echo 'distribute: the source checkout is dirty; commit or remove all changes before preparing a release' >&2
  exit 2
}

STAGE="$(mktemp -d "$OUT_PARENT/.databrain-codex-release.XXXXXX")"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT
APP="$STAGE/DataBrain MCP.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
ditto "$APP_SOURCE" "$APP"

verify_identity() {
  "$CONTENTS/Frameworks/node/bin/node" --input-type=module - "$CONTENTS" "$ROOT/setup/mcp/package-identity.mjs" "$SOURCE_REVISION" <<'NODE'
import { pathToFileURL } from 'node:url';
const [contents, modulePath, expectedRevision] = process.argv.slice(2);
const { readCodexPackageIdentity } = await import(pathToFileURL(modulePath));
const identity = await readCodexPackageIdentity(contents);
if (identity.build.source_tree !== 'clean' || identity.build.engine_revision !== expectedRevision) {
  throw new Error('The candidate was not built from the current clean source revision.');
}
process.stdout.write(`${identity.packageInfo.version}\t${identity.packageInfo.architecture}\n`);
NODE
}

PACKAGE_RECORD="$(verify_identity)" || { echo 'distribute: the unsigned candidate failed its package identity check' >&2; exit 2; }
IFS=$'\t' read -r VERSION ARCH <<< "$PACKAGE_RECORD"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$ARCH" =~ ^darwin-(arm64|x64)$ ]] || {
  echo 'distribute: the candidate version or architecture is not a stable release value' >&2
  exit 2
}

echo 'Signing bundled runtimes.' >&2
codesign --force --sign "$IDENTITY" --options runtime --timestamp "$CONTENTS/Frameworks/node/bin/node"
codesign --force --sign "$IDENTITY" --options runtime --timestamp "$RESOURCES/runtime/bin/rg"

# Runtime signatures change their bytes. Refresh the payload digest before sealing the app.
find "$CONTENTS" -type f ! -path '*/_CodeSignature/*' ! -name CodeResources ! -path "$RESOURCES/PAYLOAD.sha256" -print |
  LC_ALL=C sort |
  while IFS= read -r file; do
    relative="${file#"$CONTENTS/"}"
    digest="$(shasum -a 256 "$file" | awk '{print $1}')"
    printf '%s  %s\n' "$digest" "$relative"
  done > "$RESOURCES/PAYLOAD.sha256"

codesign --force --sign "$IDENTITY" --options runtime --timestamp "$APP"
codesign --verify --deep --strict "$APP"
verify_identity >/dev/null || { echo 'distribute: the signed app failed its payload identity check' >&2; exit 2; }

STEM="databrain-codex-$VERSION-$ARCH"
NOTARY_ZIP="$STAGE/$STEM-notary.zip"
ditto -c -k --keepParent "$APP" "$NOTARY_ZIP"
echo 'Submitting the signed app for Apple notarization.' >&2
xcrun notarytool submit "$NOTARY_ZIP" --keychain-profile "$KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose "$APP"
codesign --verify --deep --strict "$APP"
verify_identity >/dev/null || { echo 'distribute: the notarized app failed its payload identity check' >&2; exit 2; }

mkdir "$STAGE/assets"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$STAGE/assets/$STEM.zip"
cp "$RESOURCES/BUILDINFO.txt" "$STAGE/assets/$STEM.buildinfo.txt"
(cd "$STAGE/assets" && shasum -a 256 "$STEM.zip") > "$STAGE/assets/$STEM.zip.sha256"
mv "$STAGE/assets" "$OUT_DIR"
echo "Prepared signed, notarized release assets in: $OUT_DIR" >&2
