#!/bin/bash
# Uninstall DataBrain for ChatGPT. Double-click this file (Terminal opens and runs it).
#
# It removes what "Install DataBrain for ChatGPT" added, and nothing else:
#   1. the save-a-note skill ~/.agents/skills/databrain-save-note (only if DataBrain created it: a folder of that name that is not ours is left alone);
#   2. the entry named "databrain" in ~/.codex/config.toml (only if it points into DataBrain's own app folder), after a backup of the file;
#      and the marked always-on rule block (developer_instructions) in the same file, if DataBrain added it;
#   3. this version's copy of DataBrain in ~/Library/Application Support/DataBrain/app/<version>/.
# It never touches your DataBrain (your index and notes), your documents, or any other tool or skill. Bash 3.2 and tools that ship with macOS only.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(tr -d '[:space:]' < "$HERE/payload/setup/chatgpt/VERSION" 2>/dev/null)"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) printf '%s\n' "This folder is incomplete (its version file is missing), so nothing was removed. Download the installer again and open the new copy."; exit 1 ;;
esac
APP_ROOT="$HOME/Library/Application Support/DataBrain/app"
DEST="$APP_ROOT/$VERSION"
CONFIG="$HOME/.codex/config.toml"
SKILL_NAME="databrain-save-note"
SKILL_ROOT="$HOME/.agents/skills"
SKILL_DEST="$SKILL_ROOT/$SKILL_NAME"
SKILL_MARKER="databrain-managed-skill: $SKILL_NAME"

interactive() { [ -t 0 ] && [ -t 1 ]; }
say() { printf '%s\n' "$*"; }
shown() { printf '%s' "$1" | sed "s|^$HOME|~|"; }
skill_is_ours() {
  [ -d "$1" ] && [ ! -L "$1" ] || return 1
  [ -f "$1/SKILL.md" ] && [ ! -L "$1/SKILL.md" ] || return 1
  [ "$(find "$1" -mindepth 1 | wc -l | tr -d ' ')" = "1" ] || return 1
  grep -qF "$SKILL_MARKER" "$1/SKILL.md"
}

say "Uninstalling DataBrain for ChatGPT $VERSION"
say ""

# 1. the skill
if [ -e "$SKILL_DEST" ] || [ -L "$SKILL_DEST" ]; then
  if skill_is_ours "$SKILL_DEST"; then rm -rf "$SKILL_DEST" && say "  Skill:      removed $(shown "$SKILL_DEST")"
  else say "  Skill:      $(shown "$SKILL_DEST") was not created by DataBrain, so it was left alone"; fi
else
  say "  Skill:      none to remove"
fi

# 2. the settings entry: only DataBrain's own (its command points into the app folder), with a backup first
CONFIG_NOTE="not listed, nothing to change"
RULE_NOTE=""
if [ -f "$CONFIG" ]; then
  AWK_HEADER='/^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*("databrain"|databrain)[ \t]*(\.[^]]*)?\][ \t]*(#.*)?$/'
  FOUND="$(awk -v prefix="$APP_ROOT/" '
    function ours(l) { return l ~ '"$AWK_HEADER"' }
    function header(l) { return l ~ /^[ \t]*\[/ }
    { if (ours($0)) { inside = 1; found = 1; next }
      if (header($0)) { inside = 0; next }
      if (inside && $0 ~ /^[ \t]*command[ \t]*=/) { if (index($0, prefix) > 0) pointsHere = 1; else pointsElsewhere = 1 } }
    END { if (!found) print "none"; else if (pointsHere && !pointsElsewhere) print "ours"; else print "foreign" }' "$CONFIG")"
  case "$FOUND" in
    ours)
      NEW_CONFIG="$(mktemp "${TMPDIR:-/tmp}/databrain-config.XXXXXX")"
      awk '
        function ours(l) { return l ~ '"$AWK_HEADER"' }
        function header(l) { return l ~ /^[ \t]*\[/ }
        { if (ours($0)) { inside = 1; pending = ""; next }
          if (inside) {
            if (header($0)) { printf "%s", pending; pending = ""; inside = 0; print; next }
            if ($0 ~ /^[ \t]*(#.*)?$/) { pending = pending $0 "\n"; next }
            pending = ""; next
          }
          print }
        END { if (inside) printf "%s", pending }' "$CONFIG" > "$NEW_CONFIG"
      /usr/bin/perl -0pi -e 's/\n\n\z/\n/' "$NEW_CONFIG"   # the installer put one blank line before its entry; it goes with it
      RULE_NOTE="$(bash "$HERE/payload/setup/chatgpt/always-on-rule.sh" remove "$NEW_CONFIG" --no-backup 2>&1)" || RULE_NOTE="could not be changed, so it was left as it was"   # the marked rule block goes in the same backup and write
      BACKUP="$CONFIG.databrain-backup-$(date +%Y%m%d-%H%M%S)"
      if cp -p "$CONFIG" "$BACKUP" && cat "$NEW_CONFIG" > "$CONFIG"; then CONFIG_NOTE="DataBrain removed (the old file is saved as $(shown "$BACKUP"))"
      else CONFIG_NOTE="could not be changed, so it was left as it was"; fi
      rm -f "$NEW_CONFIG" ;;
    foreign) CONFIG_NOTE="has a \"databrain\" entry that is not DataBrain's own, so it was left alone" ;;
  esac
fi
say "  ChatGPT:    $(shown "$CONFIG") $CONFIG_NOTE"
if [ -z "$RULE_NOTE" ]; then RULE_NOTE="$(bash "$HERE/payload/setup/chatgpt/always-on-rule.sh" remove "$CONFIG" 2>&1)" || RULE_NOTE="could not be changed, so it was left as it was"; fi
say "  Rule:       $RULE_NOTE"

# 3. this version's copy
if [ -d "$DEST" ] && [ ! -L "$DEST" ]; then rm -rf "$DEST" && say "  Program:    removed $(shown "$DEST")"
else say "  Program:    none to remove at $(shown "$DEST")"; fi

say ""
say "Your DataBrain (your index and notes) and your documents were not touched."
say "Quit ChatGPT (Command-Q) and open it again."
if interactive; then say ""; printf 'Press Return to close this window. '; read -r _; fi
exit 0
