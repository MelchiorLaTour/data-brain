#!/bin/bash
# Install DataBrain for ChatGPT. Double-click this file (Terminal opens and runs it).
#
# What it does, in order, and nothing else:
#   1. checks that this folder is complete and unchanged (a sha256 for every file);
#   2. copies DataBrain and its own copy of Node to ~/Library/Application Support/DataBrain/app/<version>/;
#   3. adds one entry named "databrain" to ~/.codex/config.toml (the file ChatGPT reads for local tools), after a backup;
#   4. stops DataBrain servers from an earlier install that are still running (ChatGPT's helper can keep one alive for days with the old code);
#   5. adds one small skill, ~/.agents/skills/databrain-save-note/SKILL.md, that tells ChatGPT to save notes through DataBrain. It never replaces a folder of
#      that name that DataBrain did not create (the file carries DataBrain's marker line), and "Uninstall DataBrain for ChatGPT" removes it.
#   6. adds one marked block (developer_instructions: a short rule telling ChatGPT to look in DataBrain first and to keep private files private) to the
#      same settings file, only when you have no developer_instructions of your own. "Uninstall DataBrain for ChatGPT" removes exactly that block.
# It never opens, reads or changes your documents and never creates your DataBrain. Running it again updates DataBrain and keeps
# the brain you already have. Bash 3.2 and tools that ship with macOS only.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$HERE/payload"
MANIFEST="$HERE/PAYLOAD.sha256"
# The Node that ships inside the package: the unmodified official 24.22.2 build for Apple Silicon, signed and notarized by the Node.js Foundation.
NODE_SHA256="b6fb419f0f43bb2fbca273700294dd2f3b685a64b60e8417c295f47646a70e4a"
NODE_VERSION="v24.22.2"
NODE_TEAM="HX7739G8FX"
APP_ROOT="$HOME/Library/Application Support/DataBrain/app"
CONFIG_DIR="$HOME/.codex"
CONFIG="$CONFIG_DIR/config.toml"
TMP_LIST=""

interactive() { [ -t 0 ] && [ -t 1 ]; }
say() { printf '%s\n' "$*"; }
cleanup() { [ -n "$TMP_LIST" ] && rm -rf "$TMP_LIST"; [ -n "${STAGE:-}" ] && rm -rf "$STAGE"; return 0; }
trap cleanup EXIT
stop_here() {
  say ""
  say "DataBrain was NOT installed. $1"
  [ -n "${2:-}" ] && say "$2"
  say "Nothing on your Mac was changed."
  if interactive; then say ""; printf 'Press Return to close this window. '; read -r _; fi
  exit 1
}
shown() { printf '%s' "$1" | sed "s|^$HOME|~|"; }

say "Installing DataBrain for ChatGPT"
say ""

# 1. This Mac and this folder
[ "$(uname -s)" = "Darwin" ] || stop_here "This installer is for a Mac."
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" != "1" ]; then
  stop_here "This Mac has an Intel processor, and DataBrain for ChatGPT 0.2.1 is not supported on Intel Macs."
fi
[ -d "$PAYLOAD" ] && [ -f "$MANIFEST" ] || stop_here "This folder is incomplete (the payload folder or PAYLOAD.sha256 is missing)." "Download the installer again and open the new copy."
VERSION="$(tr -d '[:space:]' < "$PAYLOAD/setup/chatgpt/VERSION" 2>/dev/null)"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) stop_here "The version file inside this folder is missing or unreadable." "Download the installer again and open the new copy." ;;
esac

# Every file listed with its sha256, no file missing, no file added, no link.
hash_list() {
  (cd "$1" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r file; do shasum -a 256 "$file"; done)
}
verify_tree() {
  [ -z "$(find "$1" -type l 2>/dev/null)" ] || return 1
  TMP_LIST="$(mktemp -d "${TMPDIR:-/tmp}/databrain-install.XXXXXX")" || return 1
  hash_list "$1" > "$TMP_LIST/actual" 2>/dev/null || return 1
  cmp -s "$TMP_LIST/actual" "$MANIFEST"
  local status=$?
  rm -rf "$TMP_LIST"; TMP_LIST=""
  return $status
}
say "Checking the files in this folder..."
verify_tree "$PAYLOAD" || stop_here "The files in this folder do not match their checksums, so they were damaged or changed after the build." "Download the installer again and open the new copy."

NODE_IN_PAYLOAD="$PAYLOAD/node/bin/node"
[ "$(shasum -a 256 "$NODE_IN_PAYLOAD" | awk '{print $1}')" = "$NODE_SHA256" ] || stop_here "The Node program in this folder is not the expected official build." "Download the installer again and open the new copy."
codesign -dv "$NODE_IN_PAYLOAD" 2>&1 | grep -q "TeamIdentifier=$NODE_TEAM" || stop_here "The Node program in this folder is not signed by the Node.js Foundation."

# 1b. The save-a-note skill. Checked now, before anything is changed: a folder of that name that DataBrain did not create is never overwritten.
SKILL_NAME="databrain-save-note"
SKILL_SRC="$PAYLOAD/setup/chatgpt/skills/$SKILL_NAME"
SKILL_ROOT="$HOME/.agents/skills"
SKILL_DEST="$SKILL_ROOT/$SKILL_NAME"
SKILL_MARKER="databrain-managed-skill: $SKILL_NAME"
# Ours = a real folder (not a link) holding exactly one real file, SKILL.md, that carries the marker line.
skill_is_ours() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  [ -f "$1/SKILL.md" ] && [ ! -L "$1/SKILL.md" ] || return 1
  [ "$(find "$1" -mindepth 1 | wc -l | tr -d ' ')" = "1" ] || return 1
  grep -qF "$SKILL_MARKER" "$1/SKILL.md"
}
SKILL_EXISTING=0
if [ -e "$SKILL_DEST" ] || [ -L "$SKILL_DEST" ]; then
  if skill_is_ours "$SKILL_DEST"; then SKILL_EXISTING=1
  else stop_here "ChatGPT's skills folder already has something named $SKILL_NAME in $(shown "$SKILL_ROOT") that DataBrain did not create, and DataBrain will not overwrite it." "Rename or remove that folder yourself, then run this installer again."; fi
fi

# 2. The ChatGPT settings file: work out the new content first, so a refusal happens before anything is changed.
DEST="$APP_ROOT/$VERSION"
NODE_DEST="$DEST/node/bin/node"
SERVER_DEST="$DEST/setup/mcp/server.mjs"
toml_string() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
BLOCK_FILE="$(mktemp "${TMPDIR:-/tmp}/databrain-block.XXXXXX")"
NEW_CONFIG="$(mktemp "${TMPDIR:-/tmp}/databrain-config.XXXXXX")"
trap 'cleanup; rm -f "$BLOCK_FILE" "$NEW_CONFIG"' EXIT
{
  printf '[mcp_servers.databrain]\n'
  printf 'command = %s\n' "$(toml_string "$NODE_DEST")"
  printf 'args = [%s, "--databrain-client", "chatgpt", "--databrain-desktop-only"]\n' "$(toml_string "$SERVER_DEST")"
  # Part 41: Codex in Terminal reads this same file. Only the ChatGPT app's app-server sets this variable; DataBrain stands down without it.
  printf 'env_vars = ["CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]\n'
  printf 'startup_timeout_sec = 30\n'
  # The folder picker waits for the user's click inside one tool call.
  printf 'tool_timeout_sec = 1200\n'
} > "$BLOCK_FILE"

# A databrain entry already in the file is replaced only when it points into DataBrain's own app folder.
AWK_HEADER='/^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*("databrain"|databrain)[ \t]*(\.[^]]*)?\][ \t]*(#.*)?$/'
EXISTING=0
if [ -f "$CONFIG" ]; then
  FOUND="$(awk -v prefix="$APP_ROOT/" '
    function ours(l) { return l ~ '"$AWK_HEADER"' }
    function header(l) { return l ~ /^[ \t]*\[/ }
    { if (ours($0)) { inside = 1; found = 1; next }
      if (header($0)) { inside = 0; next }
      if (inside && $0 ~ /^[ \t]*command[ \t]*=/) { command = 1; if (index($0, prefix) > 0) pointsHere = 1; else pointsElsewhere = 1 } }
    END { if (!found) print "none"; else if (pointsHere && !pointsElsewhere) print "ours"; else print "foreign" }' "$CONFIG")"
  case "$FOUND" in
    ours) EXISTING=1 ;;
    foreign) stop_here "ChatGPT already has a different local tool named \"databrain\" in $(shown "$CONFIG"), and DataBrain will not overwrite it." "Rename or remove that entry yourself (its name is the line [mcp_servers.databrain]), then run this installer again." ;;
  esac
fi
if [ -f "$CONFIG" ] && [ "$EXISTING" = "1" ]; then
  awk -v blockfile="$BLOCK_FILE" '
    function ours(l) { return l ~ '"$AWK_HEADER"' }
    function header(l) { return l ~ /^[ \t]*\[/ }
    function emitblock(   line) { while ((getline line < blockfile) > 0) print line; close(blockfile) }
    { if (ours($0)) { if (!done) { emitblock(); done = 1 } inside = 1; pending = ""; next }
      if (inside) {
        if (header($0)) { printf "%s", pending; pending = ""; inside = 0; print; next }
        if ($0 ~ /^[ \t]*(#.*)?$/) { pending = pending $0 "\n"; next }
        pending = ""; next
      }
      print }
    END { if (inside) printf "%s", pending }' "$CONFIG" > "$NEW_CONFIG"
elif [ -f "$CONFIG" ]; then
  cp "$CONFIG" "$NEW_CONFIG"
  if [ -s "$NEW_CONFIG" ] && [ "$(tail -c 1 "$NEW_CONFIG" | wc -l | tr -d ' ')" = "0" ]; then printf '\n' >> "$NEW_CONFIG"; fi
  if [ -s "$NEW_CONFIG" ]; then printf '\n' >> "$NEW_CONFIG"; fi
  cat "$BLOCK_FILE" >> "$NEW_CONFIG"
else
  cp "$BLOCK_FILE" "$NEW_CONFIG"
fi

# 3. Copy DataBrain in. The copy is built beside the final place, checked again, and swapped in at the end.
say "Copying DataBrain to $(shown "$DEST")..."
mkdir -p "$APP_ROOT" || stop_here "Could not create $(shown "$APP_ROOT")."
STAGE="$APP_ROOT/.installing-$VERSION.$$"
rm -rf "$STAGE"
cp -R "$PAYLOAD" "$STAGE" || stop_here "Could not copy the files (is the disk full?)."
verify_tree "$STAGE" || stop_here "The copy on your disk did not match its checksums (the disk may be failing or full)."
OLD=""
if [ -e "$DEST" ]; then
  OLD="$APP_ROOT/.replaced-$VERSION.$$"
  mv "$DEST" "$OLD" || stop_here "Could not replace the existing copy at $(shown "$DEST")."
fi
if ! mv "$STAGE" "$DEST"; then
  [ -n "$OLD" ] && mv "$OLD" "$DEST"
  stop_here "Could not move the new copy into place."
fi
STAGE=""
[ -n "$OLD" ] && rm -rf "$OLD"

INSTALLED_NODE="$("$NODE_DEST" -v 2>/dev/null)"
if [ "$INSTALLED_NODE" != "$NODE_VERSION" ]; then
  say ""
  say "DataBrain was copied to $(shown "$DEST"), but its Node program did not start."
  say "If macOS showed a message about it, open System Settings > Privacy & Security, click Open Anyway, and run this installer again."
  say "ChatGPT was not told about DataBrain yet."
  if interactive; then say ""; printf 'Press Return to close this window. '; read -r _; fi
  exit 1
fi

# 3b. Servers an earlier install left running hold the old code while the files on disk are new. Stop only DataBrain's own servers (a program inside
# the app folder running setup/mcp/server.mjs). A stopped server is restarted by ChatGPT when it is next used; anything it was doing is resumed by
# DataBrain itself, as after any restart. The index workers are left to finish.
OLD_PIDS="$(ps -axo pid=,command= 2>/dev/null | awk -v app="$APP_ROOT/" '{ pid = $1; sub(/^[ \t]*[0-9]+[ \t]+/, ""); if (index($0, app) == 1 && index($0, "/setup/mcp/server.mjs") && !index($0, "--databrain-run-index-worker")) print pid }')"
STOPPED=0
for pid in $OLD_PIDS; do
  [ "$pid" = "$$" ] && continue
  kill -TERM "$pid" 2>/dev/null && STOPPED=$((STOPPED + 1))
done
if [ "$STOPPED" -gt 0 ]; then
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    LEFT=0; for pid in $OLD_PIDS; do kill -0 "$pid" 2>/dev/null && LEFT=1; done
    [ "$LEFT" = 0 ] && break
  done
  say "Stopped $STOPPED older DataBrain program(s) that were still running from an earlier install."
fi

# 4. Tell ChatGPT: back up the settings file, then write it.
# 6. the always-on rule: one marked block of developer_instructions, put into the new settings text before the one backup and the one write
# (it never replaces a developer_instructions the user wrote; the script says so)
RULE_NOTE="$(bash "$PAYLOAD/setup/chatgpt/always-on-rule.sh" write "$NEW_CONFIG" --no-backup 2>&1)" || RULE_NOTE="${RULE_NOTE:-could not be written}"
CONFIG_NOTE="already lists DataBrain"
if [ ! -f "$CONFIG" ] || ! cmp -s "$CONFIG" "$NEW_CONFIG"; then
  mkdir -p "$CONFIG_DIR"
  if [ -f "$CONFIG" ]; then
    BACKUP="$CONFIG.databrain-backup-$(date +%Y%m%d-%H%M%S)"
    cp -p "$CONFIG" "$BACKUP" || stop_here "Could not back up $(shown "$CONFIG") first, so it was left alone."
    CONFIG_NOTE="now lists DataBrain (the old file is saved as $(shown "$BACKUP"))"
  else
    CONFIG_NOTE="now lists DataBrain (the file did not exist and was created)"
  fi
  cat "$NEW_CONFIG" > "$CONFIG" || { say "DataBrain is copied, but $(shown "$CONFIG") could not be written."; exit 1; }
fi

# 5. The save-a-note skill: built beside its final place and swapped in, so a failure leaves the old one (or none) as it was.
SKILL_NOTE="added"
mkdir -p "$SKILL_ROOT" || { say "DataBrain is installed, but $(shown "$SKILL_ROOT") could not be created, so the save-a-note skill was not added."; exit 1; }
SKILL_STAGE="$SKILL_ROOT/.$SKILL_NAME.installing.$$"
rm -rf "$SKILL_STAGE"
if ! { mkdir "$SKILL_STAGE" && cp "$SKILL_SRC/SKILL.md" "$SKILL_STAGE/SKILL.md"; }; then
  rm -rf "$SKILL_STAGE"
  say "DataBrain is installed, but the save-a-note skill could not be written to $(shown "$SKILL_ROOT")."; exit 1
fi
if [ "$SKILL_EXISTING" = "1" ]; then
  SKILL_OLD="$SKILL_ROOT/.$SKILL_NAME.replaced.$$"
  mv "$SKILL_DEST" "$SKILL_OLD" || { rm -rf "$SKILL_STAGE"; say "DataBrain is installed, but the old save-a-note skill could not be replaced."; exit 1; }
  if mv "$SKILL_STAGE" "$SKILL_DEST"; then rm -rf "$SKILL_OLD"; SKILL_NOTE="updated"
  else mv "$SKILL_OLD" "$SKILL_DEST"; rm -rf "$SKILL_STAGE"; say "DataBrain is installed, but the save-a-note skill could not be updated."; exit 1; fi
else
  mv "$SKILL_STAGE" "$SKILL_DEST" || { rm -rf "$SKILL_STAGE"; say "DataBrain is installed, but the save-a-note skill could not be added."; exit 1; }
fi

say ""
say "DataBrain for ChatGPT $VERSION is installed."
say "  Where:      $(shown "$DEST")"
say "  ChatGPT:    $(shown "$CONFIG") $CONFIG_NOTE"
say "  Skill:      $SKILL_NOTE $(shown "$SKILL_DEST") (it tells ChatGPT to save notes through DataBrain; \"Uninstall DataBrain for ChatGPT\" removes it)"
say "  Rule:       $RULE_NOTE"
say "  Your files: not touched. No DataBrain was created, and one you already have is kept."
say ""
say "Next: quit ChatGPT (Command-Q), open it again, then type: Set up my DataBrain"
if interactive; then
  say ""
  printf 'Press Return to restart ChatGPT now, or close this window to do it yourself. '
  read -r _
  killall ChatGPT >/dev/null 2>&1
  sleep 2
  open -a ChatGPT >/dev/null 2>&1 || say "Could not open ChatGPT. Open it yourself."
fi
exit 0
