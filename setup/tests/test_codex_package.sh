#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
BUNDLE=''
while (($#)); do
  case "$1" in
    --bundle) BUNDLE="${2:-}"; shift 2 ;;
    *) echo 'Usage: setup/tests/test_codex_package.sh --bundle "path/DataBrain MCP.app"' >&2; exit 2 ;;
  esac
done
[[ -n "$BUNDLE" && -d "$BUNDLE/Contents" ]] || { echo 'test: pass one built DataBrain MCP.app bundle' >&2; exit 2; }
BUNDLE="$(cd "$BUNDLE" && pwd -P)"
CONTENTS="$BUNDLE/Contents"
RESOURCES="$CONTENTS/Resources"
PACKAGE="$RESOURCES/PACKAGE.tsv"
ARCH="$(awk -F= '$1 == "architecture" { print $2 }' "$PACKAGE")"
VERSION="$(awk -F= '$1 == "version" { print $2 }' "$PACKAGE")"
STEM="databrain-codex-$VERSION-$ARCH"
OUT_DIR="$(dirname "$(dirname "$BUNDLE")")"
ZIP="$OUT_DIR/$STEM.zip"

for file in "$CONTENTS/Info.plist" "$CONTENTS/MacOS/databrain-mcp" "$CONTENTS/Frameworks/node/bin/node" \
  "$RESOURCES/runtime/bin/rg" "$RESOURCES/PACKAGE.tsv" "$RESOURCES/BUILDINFO.txt" "$RESOURCES/PAYLOAD.sha256" \
  "$RESOURCES/LICENSE" "$RESOURCES/runtime-LICENSE.node.txt" "$RESOURCES/runtime-LICENSE.ripgrep.txt"; do
  [[ -f "$file" ]] || { echo "FAIL: missing required bundle file: ${file#"$BUNDLE/"}" >&2; exit 1; }
done
[[ -x "$CONTENTS/MacOS/databrain-mcp" && -x "$CONTENTS/Frameworks/node/bin/node" && -x "$RESOURCES/runtime/bin/rg" ]] || {
  echo 'FAIL: one or more bundled executables lack execute permission' >&2
  exit 1
}
plutil -lint "$CONTENTS/Info.plist" >/dev/null
/bin/bash -n "$CONTENTS/MacOS/databrain-mcp"
if find "$CONTENTS" -type l -print | grep -q .; then
  echo 'FAIL: bundle contains a symbolic link' >&2
  exit 1
fi
[[ -f "$ZIP" && -f "$ZIP.sha256" && -f "$OUT_DIR/$STEM.buildinfo.txt" ]] || {
  echo 'FAIL: release-shaped archive, checksum, or build record is missing' >&2
  exit 1
}
(cd "$OUT_DIR" && shasum -a 256 -c "$STEM.zip.sha256" >/dev/null)
unzip -tq "$ZIP" >/dev/null
node "$ROOT/setup/tests/test_codex_bundle.mjs" "$BUNDLE"
env DATABRAIN_TEST_LAUNCHER="$CONTENTS/MacOS/databrain-mcp" \
  node "$ROOT/setup/tests/test_codex_onboarding.mjs"
env DATABRAIN_TEST_LAUNCHER="$CONTENTS/MacOS/databrain-mcp" \
  node "$ROOT/setup/tests/test_mcp_skewed_50file.mjs" "$RESOURCES"
env DATABRAIN_TEST_LAUNCHER="$CONTENTS/MacOS/databrain-mcp" \
  node "$ROOT/setup/tests/test_codex_mixed_50file.mjs" "$RESOURCES"
env DATABRAIN_TEST_LAUNCHER="$CONTENTS/MacOS/databrain-mcp" \
  node "$ROOT/setup/tests/test_mcp_multivariant_workflow.mjs" "$RESOURCES"
env DATABRAIN_TEST_LAUNCHER="$CONTENTS/MacOS/databrain-mcp" \
  node "$ROOT/setup/tests/test_mcp_recall_exam.mjs" "$RESOURCES"
