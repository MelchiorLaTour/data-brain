#!/bin/bash
set -euo pipefail

REPOSITORY='MelchiorLaTour/data-brain'
RELEASES_URL="https://api.github.com/repos/$REPOSITORY/releases?per_page=100"
HOME_APPS="$HOME/Applications"
APP_NAME='DataBrain MCP.app'
SERVER_NAME='databrain'
STAGE=''
APP_DEST="$HOME_APPS/$APP_NAME"
APP_INCOMING=''
APP_BACKUP=''
APP_FRESH=0
UPDATE_COMMITTED=0
UPDATE_MODE=0

fail() {
  echo "DataBrain bootstrap: $*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$APP_BACKUP" && -d "$APP_BACKUP" ]]; then
    if (( UPDATE_COMMITTED == 1 )); then
      /bin/rm -rf "$APP_BACKUP"
    else
      if [[ -e "$APP_DEST" ]]; then /bin/rm -rf "$APP_DEST"; fi
      /bin/mv "$APP_BACKUP" "$APP_DEST" || echo "DataBrain bootstrap: failed to restore the previous app at '$APP_DEST'." >&2
    fi
  fi
  if (( APP_FRESH == 1 )) && [[ -d "$APP_DEST" && ! -L "$APP_DEST" ]]; then /bin/rm -rf "$APP_DEST"; fi
  if [[ -n "$APP_INCOMING" && -e "$APP_INCOMING" ]]; then /bin/rm -rf "$APP_INCOMING"; fi
  case "$STAGE" in
    "${TMPDIR:-/tmp}"/databrain-bootstrap.*) /bin/rm -rf "$STAGE" ;;
  esac
}
trap cleanup EXIT

command -v uname >/dev/null 2>&1 || fail 'Required local command is missing: uname'
[[ "$(uname -s)" == Darwin ]] || fail 'This release currently supports macOS only.'
case "$(uname -m)" in
  arm64) ARCH='darwin-arm64' ;;
  x86_64) ARCH='darwin-x64' ;;
  *) fail 'This Mac architecture is not supported by the available bundles.' ;;
esac

for command in cmp curl mkdir osascript ditto shasum grep mktemp sed codesign spctl sw_vers; do
  command -v "$command" >/dev/null 2>&1 || fail "Required local command is missing: $command"
done
MACOS_VERSION="$(sw_vers -productVersion)"
[[ "$MACOS_VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]] || fail 'Could not read the macOS version.'
MACOS_MAJOR="${MACOS_VERSION%%.*}"
(( MACOS_MAJOR >= 14 )) || fail 'The ChatGPT desktop app and DataBrain Codex bundle require macOS 14 or later.'

CODEX_BIN="$(command -v codex || true)"
if [[ -z "$CODEX_BIN" ]]; then
  for candidate in \
    "$HOME/Applications/Codex.app/Contents/Resources/codex" \
    '/Applications/Codex.app/Contents/Resources/codex'; do
    if [[ -x "$candidate" ]]; then
      CODEX_BIN="$candidate"
      break
    fi
  done
fi
[[ -n "$CODEX_BIN" ]] || fail 'Install the ChatGPT desktop app or Codex CLI before installing DataBrain.'
"$CODEX_BIN" mcp --help >/dev/null 2>&1 || fail 'The available Codex executable does not support MCP server management.'

read_registration_record() {
  local entries
  entries="$("$CODEX_BIN" mcp list --json 2>/dev/null)" || return 1
  printf '%s\n' "$entries" | osascript -l JavaScript -e '
    ObjC.import("Foundation");
    function run() {
      var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
      var text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
      var entries = JSON.parse(text);
      var entry = entries.find(function (candidate) { return candidate.name === "databrain"; });
      if (!entry) return "missing";
      var transport = entry.transport || {};
      return ["present", transport.type || "", transport.command || "", JSON.stringify(transport.args || []),
        transport.env === null || transport.env === undefined ? "null" : JSON.stringify(transport.env),
        JSON.stringify(transport.env_vars || []), transport.cwd === null || transport.cwd === undefined ? "null" : String(transport.cwd)].join("\t");
    }
  ' 2>/dev/null
}

registration_record_matches_managed() {
  local state entry_type entry_command entry_args entry_env entry_env_vars entry_cwd
  IFS=$'\t' read -r state entry_type entry_command entry_args entry_env entry_env_vars entry_cwd <<< "$1"
  [[ "$state" == present && "$entry_type" == stdio && "$entry_command" == "$APP_DEST/Contents/MacOS/databrain-mcp" &&
    "$entry_args" == '[]' && "$entry_env" == null && "$entry_env_vars" == '[]' && "$entry_cwd" == null ]]
}

MCP_REGISTRATION="$(read_registration_record)" || fail 'Could not safely inspect the Codex MCP registrations.'
if [[ "$MCP_REGISTRATION" != missing ]]; then
  registration_record_matches_managed "$MCP_REGISTRATION" || fail "An MCP server named '$SERVER_NAME' already exists with a different configuration. Preserve and review that entry before installing."
  UPDATE_MODE=1
fi

echo 'Looking for the latest stable, architecture-matched DataBrain Codex release.' >&2
RELEASE_RECORD="$(
  curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 90 \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' "$RELEASES_URL" |
  osascript -l JavaScript -e '
    ObjC.import("Foundation");
    function run() {
      var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
      var text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
      var releases = JSON.parse(text);
      var prefix = "databrain-codex-";
      var suffix = "-" + "'"$ARCH"'" + ".zip";
      for (var i = 0; i < releases.length; i += 1) {
        var release = releases[i];
        if (release.draft || release.prerelease || !Array.isArray(release.assets)) continue;
        var zip = null;
        var version = null;
        var checksum = null;
        var buildInfo = null;
        for (var j = 0; j < release.assets.length; j += 1) {
          var asset = release.assets[j];
          if (asset.name.indexOf(prefix) !== 0 || asset.name.slice(-suffix.length) !== suffix) continue;
          var candidateVersion = asset.name.slice(prefix.length, -suffix.length);
          if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(candidateVersion)) continue;
          zip = asset;
          version = candidateVersion;
        }
        if (!zip) continue;
        var stem = prefix + version + "-" + "'"$ARCH"'";
        for (var k = 0; k < release.assets.length; k += 1) {
          var sibling = release.assets[k];
          if (sibling.name === stem + ".zip.sha256") checksum = sibling;
          if (sibling.name === stem + ".buildinfo.txt") buildInfo = sibling;
        }
        if (release.tag_name !== "v" + version || !checksum || !buildInfo) continue;
        return [release.tag_name, version, zip.browser_download_url, checksum.browser_download_url, buildInfo.browser_download_url].join("\t");
      }
      throw new Error("No stable DataBrain Codex release with matching ZIP, checksum, and build record was found.");
    }
  '
)" || fail 'Could not find or read a stable Codex release with matching ZIP, checksum, and build record.'

IFS=$'\t' read -r TAG VERSION ZIP_URL CHECKSUM_URL BUILDINFO_URL <<< "$RELEASE_RECORD"
[[ "$TAG" == "v$VERSION" && "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'The release metadata is malformed.'
for url in "$ZIP_URL" "$CHECKSUM_URL" "$BUILDINFO_URL"; do
  [[ "$url" == "https://github.com/$REPOSITORY/releases/download/"* ]] || fail 'A release asset points outside the canonical GitHub repository.'
done

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/databrain-bootstrap.XXXXXX")"
ZIP_NAME="databrain-codex-$VERSION-$ARCH.zip"
CHECKSUM_NAME="$ZIP_NAME.sha256"
BUILDINFO_NAME="databrain-codex-$VERSION-$ARCH.buildinfo.txt"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 600 "$ZIP_URL" -o "$STAGE/$ZIP_NAME"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 90 "$CHECKSUM_URL" -o "$STAGE/$CHECKSUM_NAME"
curl --fail --location --silent --show-error --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 90 "$BUILDINFO_URL" -o "$STAGE/$BUILDINFO_NAME"
(cd "$STAGE" && shasum -a 256 -c "$CHECKSUM_NAME" >/dev/null) || fail 'The downloaded release ZIP failed its published SHA-256 check.'

grep -Fqx 'package_kind=codex' "$STAGE/$BUILDINFO_NAME" || fail 'The release build record is not for Codex.'
grep -Fqx "package_version=$VERSION" "$STAGE/$BUILDINFO_NAME" || fail 'The release version does not match its asset name.'
grep -Fqx "architecture=$ARCH" "$STAGE/$BUILDINFO_NAME" || fail 'The release architecture does not match this Mac.'
grep -Fqx 'source_tree=clean' "$STAGE/$BUILDINFO_NAME" || fail 'The release was not built from a clean source tree.'

mkdir "$STAGE/unpacked"
ditto -x -k "$STAGE/$ZIP_NAME" "$STAGE/unpacked"
APP_SOURCE="$STAGE/unpacked/$APP_NAME"
[[ -d "$APP_SOURCE/Contents" && -x "$APP_SOURCE/Contents/MacOS/databrain-mcp" ]] || fail 'The release ZIP does not contain the expected app bundle.'
cmp "$STAGE/$BUILDINFO_NAME" "$APP_SOURCE/Contents/Resources/BUILDINFO.txt" || fail 'The archive build record differs from the release record.'
(
  cd "$APP_SOURCE/Contents"
  shasum -a 256 -c Resources/PAYLOAD.sha256 >/dev/null
) || fail 'The app payload failed its embedded integrity check.'
codesign --verify --deep --strict "$APP_SOURCE" >/dev/null 2>&1 || fail 'The app signature is missing or invalid.'
spctl --assess --type execute "$APP_SOURCE" >/dev/null 2>&1 || fail 'macOS Gatekeeper did not accept the app signature.'
DATABRAIN_BOOTSTRAP_CONTENTS="$APP_SOURCE/Contents" \
  "$APP_SOURCE/Contents/Frameworks/node/bin/node" --input-type=module -e '
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const root = process.env.DATABRAIN_BOOTSTRAP_CONTENTS;
    const moduleAt = name => import(pathToFileURL(path.join(root, "Resources", "setup", "mcp", name)));
    const { readCodexPackageIdentity } = await moduleAt("package-identity.mjs");
    const { checkGitHubRelease } = await moduleAt("github-release-check.mjs");
    const identity = await readCodexPackageIdentity(root);
    const result = await checkGitHubRelease({ manifest: null, packageInfo: identity.packageInfo, build: identity.build, timeoutMs: 30000 });
    if (result.state !== "PASS") {
      console.error(`${result.state}: ${result.detail}`);
      process.exitCode = 1;
    } else {
      console.log(result.detail);
    }
  ' || fail 'The downloaded app did not pass the canonical GitHub release, source revision, and payload checks.'

[[ ! -L "$HOME_APPS" ]] || fail "The user Applications folder is a symbolic link: '$HOME_APPS'."
mkdir -p "$HOME_APPS"
[[ -d "$HOME_APPS" && ! -L "$HOME_APPS" ]] || fail 'The user Applications path is not a regular directory.'
[[ ! -L "$APP_DEST" ]] || fail "The app destination is a symbolic link: '$APP_DEST'."
if [[ -e "$APP_DEST" ]]; then
  [[ -d "$APP_DEST/Contents" ]] || fail "An item already exists at '$APP_DEST'; preserve it and review before installing."
  [[ -f "$APP_DEST/Contents/Resources/BUILDINFO.txt" ]] || fail "The existing app at '$APP_DEST' has no build record; preserve it and review before upgrading."
  (
    cd "$APP_DEST/Contents"
    shasum -a 256 -c Resources/PAYLOAD.sha256 >/dev/null
  ) || fail "The existing app at '$APP_DEST' failed its integrity check."
  codesign --verify --deep --strict "$APP_DEST" >/dev/null 2>&1 || fail 'The existing app signature is missing or invalid.'
  spctl --assess --type execute "$APP_DEST" >/dev/null 2>&1 || fail 'macOS Gatekeeper did not accept the existing app signature.'
  grep -Fqx 'package_kind=codex' "$APP_DEST/Contents/Resources/BUILDINFO.txt" || fail 'The existing app is not a Codex package.'
  grep -Fqx "architecture=$ARCH" "$APP_DEST/Contents/Resources/BUILDINFO.txt" || fail 'The existing app targets a different architecture.'
  if cmp -s "$STAGE/$BUILDINFO_NAME" "$APP_DEST/Contents/Resources/BUILDINFO.txt"; then
    if (( UPDATE_MODE == 1 )); then
      echo "DataBrain $VERSION ($ARCH) is already installed and verified at $APP_DEST."
      exit 0
    fi
  else
    (( UPDATE_MODE == 1 )) || fail "A different app exists at '$APP_DEST' without its matching Codex registration. Preserve it and review the configuration before installing."
    OLD_VERSION="$(sed -n 's/^package_version=//p' "$APP_DEST/Contents/Resources/BUILDINFO.txt")"
    [[ "$OLD_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'The existing app version is invalid; preserve it and review before upgrading.'
    if [[ "$OLD_VERSION" == "$VERSION" ]]; then
      fail 'The installed app has different build metadata for the same version; preserve it and review before replacing it.'
    fi
    version_is_newer() {
      local left="$1" right="$2" lpart rpart index
      local -a left_parts right_parts
      IFS=. read -r -a left_parts <<< "$left"
      IFS=. read -r -a right_parts <<< "$right"
      for index in 0 1 2; do
        lpart=$((10#${left_parts[$index]}))
        rpart=$((10#${right_parts[$index]}))
        (( lpart > rpart )) && return 0
        (( lpart < rpart )) && return 1
      done
      return 1
    }
    version_is_newer "$VERSION" "$OLD_VERSION" || fail "The stable release $VERSION is not newer than the installed version $OLD_VERSION; refusing a downgrade."
    MCP_REGISTRATION="$(read_registration_record)" || fail "Could not inspect the '$SERVER_NAME' MCP registration during update; the installed app was preserved."
    registration_record_matches_managed "$MCP_REGISTRATION" || fail "The '$SERVER_NAME' MCP registration changed during update; the installed app was preserved."
    APP_INCOMING="$HOME_APPS/.DataBrain MCP.app.incoming.$$"
    APP_BACKUP="$HOME_APPS/.DataBrain MCP.app.rollback.$$"
    [[ ! -e "$APP_INCOMING" && ! -e "$APP_BACKUP" ]] || fail 'A temporary install or rollback path already exists; preserve it and review before retrying.'
    ditto "$APP_SOURCE" "$APP_INCOMING"
    cmp "$STAGE/$BUILDINFO_NAME" "$APP_INCOMING/Contents/Resources/BUILDINFO.txt" || fail 'The staged update build record does not match the release.'
    codesign --verify --deep --strict "$APP_INCOMING" >/dev/null 2>&1 || fail 'The staged update signature is missing or invalid.'
    spctl --assess --type execute "$APP_INCOMING" >/dev/null 2>&1 || fail 'Gatekeeper rejected the staged update.'
    /bin/mv "$APP_DEST" "$APP_BACKUP"
    /bin/mv "$APP_INCOMING" "$APP_DEST"
    APP_INCOMING=''
    (
      cd "$APP_DEST/Contents"
      shasum -a 256 -c Resources/PAYLOAD.sha256 >/dev/null
    ) || fail 'The installed update failed its payload integrity check; restoring the previous app.'
    cmp "$STAGE/$BUILDINFO_NAME" "$APP_DEST/Contents/Resources/BUILDINFO.txt" || fail 'The installed update build record changed; restoring the previous app.'
    codesign --verify --deep --strict "$APP_DEST" >/dev/null 2>&1 || fail 'The installed update signature failed verification; restoring the previous app.'
    spctl --assess --type execute "$APP_DEST" >/dev/null 2>&1 || fail 'Gatekeeper rejected the installed update; restoring the previous app.'
  MCP_REGISTRATION="$(read_registration_record)" || fail "Could not confirm the '$SERVER_NAME' MCP registration after update; restoring the previous app."
  registration_record_matches_managed "$MCP_REGISTRATION" || fail "The '$SERVER_NAME' MCP registration changed during update; restoring the previous app."
  UPDATE_COMMITTED=1
  /bin/rm -rf "$APP_BACKUP"
    APP_BACKUP=''
  fi
else
  APP_INCOMING="$HOME_APPS/.DataBrain MCP.app.incoming.$$"
  [[ ! -e "$APP_INCOMING" ]] || fail 'A temporary install path already exists; preserve it and review before retrying.'
  ditto "$APP_SOURCE" "$APP_INCOMING"
  /bin/mv "$APP_INCOMING" "$APP_DEST"
  APP_INCOMING=''
  APP_FRESH=1
  (
    cd "$APP_DEST/Contents"
    shasum -a 256 -c Resources/PAYLOAD.sha256 >/dev/null
  ) || fail 'The installed app failed its payload integrity check.'
  cmp "$STAGE/$BUILDINFO_NAME" "$APP_DEST/Contents/Resources/BUILDINFO.txt" || fail 'The installed app build record changed during copy.'
  codesign --verify --deep --strict "$APP_DEST" >/dev/null 2>&1 || fail 'The installed app signature failed verification.'
  spctl --assess --type execute "$APP_DEST" >/dev/null 2>&1 || fail 'Gatekeeper rejected the installed app.'
fi

if (( UPDATE_MODE == 1 )); then
  echo 'The existing Codex MCP entry still points to the updated bundle path.'
else
  MCP_REGISTRATION="$(read_registration_record)" || fail "The app is installed at '$APP_DEST', but Codex MCP configuration could not be inspected. Review the config before retrying."
  [[ "$MCP_REGISTRATION" == missing ]] || fail "An MCP server named '$SERVER_NAME' appeared during installation. The app is at '$APP_DEST'; the existing registration was preserved. Review it before retrying."
  if ! "$CODEX_BIN" mcp add "$SERVER_NAME" -- "$APP_DEST/Contents/MacOS/databrain-mcp"; then
    fail "The app is installed at '$APP_DEST', but MCP registration failed. Review the config before retrying."
  fi
  APP_FRESH=0
fi

if (( UPDATE_MODE == 1 )); then
  if [[ -n "${OLD_VERSION:-}" ]]; then
    echo "Updated DataBrain from $OLD_VERSION to $VERSION ($ARCH) at $APP_DEST."
  else
    echo "Reinstalled DataBrain $VERSION ($ARCH) at its existing registered path: $APP_DEST."
  fi
else
  echo "Installed and registered DataBrain $VERSION ($ARCH) at $APP_DEST."
fi
echo 'Restart ChatGPT desktop to load the new MCP server, then ask DataBrain to set itself up.'
