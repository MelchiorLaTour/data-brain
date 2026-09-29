#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
BOOTSTRAP="$ROOT/setup/codex/bootstrap.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/databrain-codex-bootstrap-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

case "$(uname -m)" in
  arm64) ARCH='darwin-arm64' ;;
  x86_64) ARCH='darwin-x64' ;;
  *) echo 'test: run on an arm64 or x64 Mac' >&2; exit 2 ;;
esac

mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/tmp" "$TEST_ROOT/fixture/DataBrain MCP.app/Contents" "$TEST_ROOT/home"
FIXTURE_APP="$TEST_ROOT/fixture/DataBrain MCP.app"
cat > "$TEST_ROOT/bin/curl" <<'SH'
#!/bin/bash
set -euo pipefail
url=''
output=''
while (($#)); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ -z "$output" ]]; then
  printf '[]'
  exit 0
fi
case "$url" in
  *.zip.sha256) cp "$DATABRAIN_BOOTSTRAP_TEST_ROOT/$DATABRAIN_BOOTSTRAP_TEST_STEM.sha256" "$output" ;;
  *.buildinfo.txt) cp "$DATABRAIN_BOOTSTRAP_TEST_ROOT/$DATABRAIN_BOOTSTRAP_TEST_STEM.buildinfo.txt" "$output" ;;
  *.zip) cp "$DATABRAIN_BOOTSTRAP_TEST_ROOT/$DATABRAIN_BOOTSTRAP_TEST_STEM.zip" "$output" ;;
  *) echo 'unexpected test download URL' >&2; exit 1 ;;
esac
SH

cat > "$TEST_ROOT/bin/osascript" <<'SH'
#!/bin/bash
if [[ "$*" == *'transport.command'* ]]; then
  entries="$(cat)"
  command="$(printf '%s' "$entries" | sed -n 's/.*"command":"\([^"]*\)".*/\1/p')"
  if [[ -z "$command" ]]; then printf 'missing\n'; else printf 'present\tstdio\t%s\t[]\tnull\t[]\tnull\n' "$command"; fi
else
  cat >/dev/null
  version="$DATABRAIN_BOOTSTRAP_TEST_VERSION"
  printf 'v%s\t%s\thttps://github.com/MelchiorLaTour/data-brain/releases/download/v%s/%s.zip\thttps://github.com/MelchiorLaTour/data-brain/releases/download/v%s/%s.zip.sha256\thttps://github.com/MelchiorLaTour/data-brain/releases/download/v%s/%s.buildinfo.txt\n' \
    "$version" "$version" "$version" "$DATABRAIN_BOOTSTRAP_TEST_STEM" "$version" "$DATABRAIN_BOOTSTRAP_TEST_STEM" "$version" "$DATABRAIN_BOOTSTRAP_TEST_STEM"
fi
SH

cat > "$TEST_ROOT/bin/ditto" <<'SH'
#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == '-x' ]]; then
  mkdir -p "$4/DataBrain MCP.app"
  cp -R "$DATABRAIN_BOOTSTRAP_TEST_ROOT/fixture/DataBrain MCP.app/Contents" "$4/DataBrain MCP.app/"
else
  mkdir -p "$2"
  cp -R "$1/Contents" "$2/"
fi
SH

cat > "$TEST_ROOT/bin/codex-mock" <<'SH'
#!/bin/bash
set -euo pipefail
if [[ "${1:-}" == mcp && "${2:-}" == --help ]]; then
  exit 0
elif [[ "${1:-}" == mcp && "${2:-}" == list && "${3:-}" == --json ]]; then
  count=0
  [[ ! -f "$DATABRAIN_BOOTSTRAP_TEST_ROOT/list-count" ]] || count="$(cat "$DATABRAIN_BOOTSTRAP_TEST_ROOT/list-count")"
  count=$((count + 1))
  printf '%s\n' "$count" > "$DATABRAIN_BOOTSTRAP_TEST_ROOT/list-count"
  if [[ "${DATABRAIN_BOOTSTRAP_TEST_RACE:-}" == 1 && "$count" -eq 2 && ! -f "$DATABRAIN_BOOTSTRAP_TEST_ROOT/registered" ]]; then
    printf '%s\n' '/usr/bin/true' > "$DATABRAIN_BOOTSTRAP_TEST_ROOT/registration-command"
    touch "$DATABRAIN_BOOTSTRAP_TEST_ROOT/registered"
  fi
  if [[ -f "$DATABRAIN_BOOTSTRAP_TEST_ROOT/registration-command" ]]; then
    printf '[{"name":"databrain","transport":{"type":"stdio","command":"%s","args":[],"env":null,"env_vars":[],"cwd":null}}]\n' "$(cat "$DATABRAIN_BOOTSTRAP_TEST_ROOT/registration-command")"
  else
    printf '[]\n'
  fi
elif [[ "${1:-}" == mcp && "${2:-}" == add ]]; then
  [[ "${DATABRAIN_BOOTSTRAP_TEST_FAIL_ADD:-}" != 1 ]] || exit 1
  printf '%s\n' "$@" > "$DATABRAIN_BOOTSTRAP_TEST_ROOT/mcp-args.txt"
  printf '%s\n' "${@: -1}" > "$DATABRAIN_BOOTSTRAP_TEST_ROOT/registration-command"
  touch "$DATABRAIN_BOOTSTRAP_TEST_ROOT/registered"
else
  exit 2
fi
SH
cat > "$TEST_ROOT/bin/codex" <<'SH'
#!/bin/bash
printf 'PATH\n' >> "$DATABRAIN_BOOTSTRAP_TEST_ROOT/codex-source.txt"
exec "$DATABRAIN_BOOTSTRAP_TEST_ROOT/bin/codex-mock" "$@"
SH

mkdir -p "$TEST_ROOT/home/Applications/Codex.app/Contents/Resources" "$TEST_ROOT/bin-without-codex" "$TEST_ROOT/bin-old-macos" "$TEST_ROOT/bin-missing-cmp" "$TEST_ROOT/bin-missing-uname"
ln -s "$(command -v uname)" "$TEST_ROOT/bin-missing-cmp/uname"
cat > "$TEST_ROOT/home/Applications/Codex.app/Contents/Resources/codex" <<'SH'
#!/bin/bash
printf 'CHATGPT_DESKTOP\n' >> "$DATABRAIN_BOOTSTRAP_TEST_ROOT/codex-source.txt"
exec "$DATABRAIN_BOOTSTRAP_TEST_ROOT/bin/codex-mock" "$@"
SH

cat > "$TEST_ROOT/bin/codesign" <<'SH'
#!/bin/bash
exit 0
SH
cat > "$TEST_ROOT/bin/spctl" <<'SH'
#!/bin/bash
set -euo pipefail
target="${@: -1}"
if [[ "${DATABRAIN_BOOTSTRAP_TEST_FAIL_INSTALLED:-}" == 1 && "$target" == "$HOME/Applications/DataBrain MCP.app" &&
  -f "$target/Contents/Resources/BUILDINFO.txt" ]] && grep -Fqx 'package_version=1.2.5' "$target/Contents/Resources/BUILDINFO.txt"; then
  exit 1
fi
exit 0
SH
cat > "$TEST_ROOT/bin/sw_vers" <<'SH'
#!/bin/bash
printf '14.0.0\n'
SH
chmod 755 "$TEST_ROOT/bin/"*
chmod 755 "$TEST_ROOT/home/Applications/Codex.app/Contents/Resources/codex"
for command in curl osascript ditto codesign spctl sw_vers; do
  ln -s "$TEST_ROOT/bin/$command" "$TEST_ROOT/bin-without-codex/$command"
done
for command in curl osascript ditto codesign spctl; do
  ln -s "$TEST_ROOT/bin/$command" "$TEST_ROOT/bin-old-macos/$command"
done
cat > "$TEST_ROOT/bin-old-macos/sw_vers" <<'SH'
#!/bin/bash
printf '13.6.0\n'
SH
chmod 755 "$TEST_ROOT/bin-old-macos/sw_vers"

mkdir -p "$FIXTURE_APP/Contents/MacOS" "$FIXTURE_APP/Contents/Frameworks/node/bin" "$FIXTURE_APP/Contents/Resources"
printf '#!/bin/sh\nexit 0\n' > "$FIXTURE_APP/Contents/MacOS/databrain-mcp"
cat > "$FIXTURE_APP/Contents/Frameworks/node/bin/node" <<'SH'
#!/bin/sh
printf 'PASS: mocked package verifier\n'
SH
chmod 755 "$FIXTURE_APP/Contents/MacOS/databrain-mcp" "$FIXTURE_APP/Contents/Frameworks/node/bin/node"
prepare_release() {
  local version="$1" stem zip_name node_hash zip_hash
  stem="databrain-codex-$version-$ARCH"
  zip_name="$stem.zip"
  cat > "$TEST_ROOT/$stem.buildinfo.txt" <<EOF
package_kind=codex
package_version=$version
architecture=$ARCH
engine_repository=https://github.com/MelchiorLaTour/data-brain.git
engine_revision=0123456789012345678901234567890123456789
source_tree=clean
source_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
EOF
  cp "$TEST_ROOT/$stem.buildinfo.txt" "$FIXTURE_APP/Contents/Resources/BUILDINFO.txt"
  printf 'kind=codex\nversion=%s\narchitecture=%s\nruntime_version=24.21.0\nrg_version=15.2.0\n' "$version" "$ARCH" > "$FIXTURE_APP/Contents/Resources/PACKAGE.tsv"
  node_hash="$(shasum -a 256 "$FIXTURE_APP/Contents/Frameworks/node/bin/node" | awk '{print $1}')"
  printf '%s  Frameworks/node/bin/node\n' "$node_hash" > "$FIXTURE_APP/Contents/Resources/PAYLOAD.sha256"
  printf 'disposable test archive for %s\n' "$version" > "$TEST_ROOT/$zip_name"
  zip_hash="$(shasum -a 256 "$TEST_ROOT/$zip_name" | awk '{print $1}')"
  printf '%s  %s\n' "$zip_hash" "$zip_name" > "$TEST_ROOT/$stem.sha256"
  export DATABRAIN_BOOTSTRAP_TEST_STEM="$stem"
  export DATABRAIN_BOOTSTRAP_TEST_VERSION="$version"
}
prepare_release 1.2.3

export DATABRAIN_BOOTSTRAP_TEST_ROOT="$TEST_ROOT"
export HOME="$TEST_ROOT/home"
export TMPDIR="$TEST_ROOT/tmp"
export PATH="$TEST_ROOT/bin:$PATH"

APP_DEST="$HOME/Applications/DataBrain MCP.app"
if PATH="$TEST_ROOT/bin-missing-uname" /bin/bash "$BOOTSTRAP" > /dev/null 2> "$TEST_ROOT/missing-uname.stderr"; then
  echo 'FAIL: bootstrap continued without uname' >&2
  exit 1
fi
grep -Fq 'Required local command is missing: uname' "$TEST_ROOT/missing-uname.stderr"

if PATH="$TEST_ROOT/bin-missing-cmp" /bin/bash "$BOOTSTRAP" > /dev/null 2> "$TEST_ROOT/missing-cmp.stderr"; then
  echo 'FAIL: bootstrap continued without cmp' >&2
  exit 1
fi
grep -Fq 'Required local command is missing: cmp' "$TEST_ROOT/missing-cmp.stderr"

printf '%s\n' '/usr/bin/true' > "$TEST_ROOT/registration-command"
touch "$TEST_ROOT/registered"
if bash "$BOOTSTRAP" > /dev/null 2> "$TEST_ROOT/existing-entry.stderr"; then
  echo 'FAIL: bootstrap replaced a different pre-existing MCP registration' >&2
  exit 1
fi
grep -Fq 'already exists with a different configuration' "$TEST_ROOT/existing-entry.stderr"
[[ ! -e "$APP_DEST" ]]
rm -f "$TEST_ROOT/registered" "$TEST_ROOT/registration-command" "$TEST_ROOT/list-count"

export DATABRAIN_BOOTSTRAP_TEST_RACE=1
if bash "$BOOTSTRAP" > /dev/null 2> "$TEST_ROOT/race.stderr"; then
  echo 'FAIL: bootstrap overwrote a registration created during installation' >&2
  exit 1
fi
grep -Fq 'appeared during installation' "$TEST_ROOT/race.stderr"
grep -Fqx '/usr/bin/true' "$TEST_ROOT/registration-command"
rm -rf "$APP_DEST"
rm -f "$TEST_ROOT/registered" "$TEST_ROOT/registration-command" "$TEST_ROOT/list-count"
unset DATABRAIN_BOOTSTRAP_TEST_RACE

export DATABRAIN_BOOTSTRAP_TEST_FAIL_ADD=1
if bash "$BOOTSTRAP" > /dev/null 2> "$TEST_ROOT/register-failure.stderr"; then
  echo 'FAIL: bootstrap reported success after MCP registration failed' >&2
  exit 1
fi
[[ ! -e "$APP_DEST" ]]
[[ ! -f "$TEST_ROOT/registration-command" ]]
unset DATABRAIN_BOOTSTRAP_TEST_FAIL_ADD
rm -f "$TEST_ROOT/list-count"

bash "$BOOTSTRAP" > "$TEST_ROOT/install.stdout"
[[ -x "$APP_DEST/Contents/MacOS/databrain-mcp" ]]
grep -Fqx "$APP_DEST/Contents/MacOS/databrain-mcp" "$TEST_ROOT/mcp-args.txt"
grep -Fq 'Restart ChatGPT desktop' "$TEST_ROOT/install.stdout"
bash "$BOOTSTRAP" > "$TEST_ROOT/retry.stdout"
grep -Fq 'already installed and verified' "$TEST_ROOT/retry.stdout"

mkdir -p "$HOME/Library/Application Support/DataBrain/Codex" "$HOME/Desktop/DataBrain/.databrain" "$HOME/Documents"
printf 'locator stays outside the app\n' > "$HOME/Library/Application Support/DataBrain/Codex/connection.tsv"
printf 'generated index survives bundle replacement and removal\n' > "$HOME/Desktop/DataBrain/.databrain/index.tsv"
printf 'source stays read only\n' > "$HOME/Documents/approved-source.md"
PERSISTENT_BEFORE="$(shasum -a 256 "$HOME/Library/Application Support/DataBrain/Codex/connection.tsv" "$HOME/Desktop/DataBrain/.databrain/index.tsv" "$HOME/Documents/approved-source.md")"

prepare_release 1.2.4
bash "$BOOTSTRAP" > "$TEST_ROOT/update.stdout"
grep -Fq 'Updated DataBrain from 1.2.3 to 1.2.4' "$TEST_ROOT/update.stdout"
grep -Fqx 'package_version=1.2.4' "$APP_DEST/Contents/Resources/BUILDINFO.txt"
grep -Fqx "$APP_DEST/Contents/MacOS/databrain-mcp" "$TEST_ROOT/registration-command"
[[ ! -e "$HOME/Applications/.DataBrain MCP.app.rollback."* ]]

prepare_release 1.2.3
if bash "$BOOTSTRAP" > /dev/null 2> "$TEST_ROOT/downgrade.stderr"; then
  echo 'FAIL: bootstrap downgraded an installed version' >&2
  exit 1
fi
grep -Fq 'refusing a downgrade' "$TEST_ROOT/downgrade.stderr"
grep -Fqx 'package_version=1.2.4' "$APP_DEST/Contents/Resources/BUILDINFO.txt"

prepare_release 1.2.5
export DATABRAIN_BOOTSTRAP_TEST_FAIL_INSTALLED=1
if bash "$BOOTSTRAP" > /dev/null 2> "$TEST_ROOT/rollback.stderr"; then
  echo 'FAIL: bootstrap accepted a failed post-install Gatekeeper check' >&2
  exit 1
fi
grep -Fqx 'package_version=1.2.4' "$APP_DEST/Contents/Resources/BUILDINFO.txt"
grep -Fqx "$APP_DEST/Contents/MacOS/databrain-mcp" "$TEST_ROOT/registration-command"
[[ ! -e "$HOME/Applications/.DataBrain MCP.app.rollback."* ]]
unset DATABRAIN_BOOTSTRAP_TEST_FAIL_INSTALLED
PERSISTENT_AFTER="$(shasum -a 256 "$HOME/Library/Application Support/DataBrain/Codex/connection.tsv" "$HOME/Desktop/DataBrain/.databrain/index.tsv" "$HOME/Documents/approved-source.md")"
[[ "$PERSISTENT_AFTER" == "$PERSISTENT_BEFORE" ]]

mv "$APP_DEST" "$HOME/Applications/DataBrain MCP moved.app"
[[ -f "$HOME/Desktop/DataBrain/.databrain/index.tsv" ]]
rm -rf "$HOME/Applications/DataBrain MCP moved.app"
[[ -f "$HOME/Desktop/DataBrain/.databrain/index.tsv" ]]

rm "$TEST_ROOT/registered"
rm -f "$TEST_ROOT/registration-command" "$TEST_ROOT/list-count"
rm -rf "$HOME/Applications/DataBrain MCP.app" "$HOME/Applications/DataBrain MCP moved.app"

export PATH="$TEST_ROOT/bin-without-codex:/usr/bin:/bin:/usr/sbin:/sbin"
bash "$BOOTSTRAP" > "$TEST_ROOT/desktop-install.stdout"
grep -Fq 'CHATGPT_DESKTOP' "$TEST_ROOT/codex-source.txt"
grep -Fq 'PASS: mocked package verifier' "$TEST_ROOT/desktop-install.stdout"

if HOME="$TEST_ROOT/no-codex-home" PATH="$TEST_ROOT/bin-without-codex:/usr/bin:/bin:/usr/sbin:/sbin" \
  bash "$BOOTSTRAP" > /dev/null 2> "$TEST_ROOT/no-codex.stderr"; then
  echo 'FAIL: bootstrap continued without a Codex CLI or desktop app executable' >&2
  exit 1
fi
grep -Fq 'Install the ChatGPT desktop app or Codex CLI' "$TEST_ROOT/no-codex.stderr"
if HOME="$TEST_ROOT/home" PATH="$TEST_ROOT/bin-old-macos:/usr/bin:/bin:/usr/sbin:/sbin" \
  bash "$BOOTSTRAP" > /dev/null 2> "$TEST_ROOT/old-macos.stderr"; then
  echo 'FAIL: bootstrap continued below the ChatGPT desktop minimum macOS version' >&2
  exit 1
fi
grep -Fq 'require macOS 14 or later' "$TEST_ROOT/old-macos.stderr"

echo 'PASS: bootstrap verifies and installs a matching synthetic app, checks required commands, rolls back failed registration and failed updates, refuses downgrades, preserves DataBrain state and source files across replacement/removal, preserves existing/concurrent MCP registrations, and rejects missing clients or macOS versions below 14.'
