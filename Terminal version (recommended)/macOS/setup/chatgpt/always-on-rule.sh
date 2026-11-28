#!/bin/bash
# DataBrain always-on rule for ChatGPT's config file (~/.codex/config.toml): one block, written and removed by this script only.
#
#   always-on-rule.sh write  <config.toml> [--no-backup]   add the block (or bring its text up to date); never overwrites a developer_instructions the user wrote
#   always-on-rule.sh remove <config.toml> [--no-backup]   remove exactly the block (and the one blank line written after it)
#   always-on-rule.sh check  <config.toml>   print "Always-on rule: present" or "Always-on rule: missing" (changes nothing)
#
# The text is the file always-on-rule.txt next to this script (one place, one text). The block sits before the first [table] header, because a
# bare key written after a table would belong to that table. Everything else in the file stays byte for byte as it was.
# A changed file is backed up first as <config>.databrain-backup-<time> (unless --no-backup). Exit codes: 0 done (or nothing to do), 2 bad use or unreadable file, 3 the user already has their own developer_instructions: left alone.
# Bash 3.2 and tools that ship with macOS only (no python).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RULE_FILE="${DATABRAIN_RULE_FILE:-$HERE/always-on-rule.txt}"
START='# >>> databrain-managed: developer_instructions'
END='# <<< databrain-managed'
action="${1:-}"; CONFIG="${2:-}"; NO_BACKUP=0; [ "${3:-}" = "--no-backup" ] && NO_BACKUP=1   # --no-backup: the caller already backs the file up before it writes it
[ -n "$action" ] && [ -n "$CONFIG" ] || { echo "usage: always-on-rule.sh write|remove|check <config.toml>" >&2; exit 2; }
[ -f "$RULE_FILE" ] || { echo "always-on rule text is missing: $RULE_FILE" >&2; exit 2; }
RULE="$(cat "$RULE_FILE")"
case "$RULE" in *'"""'*|*'\'*) echo "always-on rule text may not contain triple quotes or backslashes" >&2; exit 2;; esac

BLOCK="$(mktemp "${TMPDIR:-/tmp}/databrain-rule.XXXXXX")" || exit 2
OUT="$(mktemp "${TMPDIR:-/tmp}/databrain-config.XXXXXX")" || exit 2
trap 'rm -f "$BLOCK" "$OUT"' EXIT
{ printf '%s (written by the DataBrain installer; remove this block to undo) >>>\n' "$START"
  printf 'developer_instructions = """%s"""\n' "$RULE"
  printf '%s <<<\n' "$END"; } > "$BLOCK"

# Line numbers of the block (first start line to the first end line after it), or nothing.
block_range() { awk -v s="$START" -v e="$END" 'index($0, s) == 1 && !from { from = NR } from && index($0, e) == 1 && !to { to = NR } END { if (from && to) print from " " to }' "$CONFIG"; }
# First line of the first [table] / [[array table]] header outside a multi-line string, or nothing.
first_table() { awk '
  { line = $0; n = gsub(/"""/, "&", line); m = gsub(/\047\047\047/, "&", line) }
  !instr && !inlit && /^[ \t]*\[/ { print NR; exit }
  { if (n % 2 == 1) instr = !instr; if (m % 2 == 1) inlit = !inlit }' "$CONFIG"; }
# A developer_instructions key the user wrote: a top-level one outside our block, before the first table.
user_key_exists() { awk -v from="${1:-0}" -v to="${2:-0}" -v tbl="${3:-0}" '
  NR >= from && NR <= to && from > 0 { next }
  tbl > 0 && NR >= tbl { exit }
  /^[ \t]*developer_instructions[ \t]*=/ { found = 1 }
  END { exit found ? 0 : 1 }' "$CONFIG"; }

# awk ends every line with a newline; a file that did not end with one gets its original ending back.
keep_ending() { if [ -s "$CONFIG" ] && [ "$(tail -c 1 "$CONFIG" | wc -l | tr -d ' ')" = "0" ]; then /usr/bin/perl -0pi -e 's/\n\z//' "$OUT"; fi; }

case "$action" in
  check)
    [ -f "$CONFIG" ] || { echo "Always-on rule: missing"; exit 0; }
    range="$(block_range)"
    if [ -n "$range" ]; then
      set -- $range
      if [ "$(sed -n "${1},${2}p" "$CONFIG" | sed -n '2p')" = "$(sed -n '2p' "$BLOCK")" ]; then echo "Always-on rule: present"; else echo "Always-on rule: missing (an older text is in the file)"; fi
    else echo "Always-on rule: missing"; fi
    exit 0 ;;
  write)
    if [ ! -f "$CONFIG" ]; then mkdir -p "$(dirname "$CONFIG")" && { cat "$BLOCK"; printf '\n'; } > "$CONFIG"; exit $?; fi
    range="$(block_range)"
    tbl="$(first_table)"
    if [ -n "$range" ]; then
      set -- $range
      from="$1"; to="$2"
      awk -v from="$from" -v to="$to" -v block="$BLOCK" 'NR == from { while ((getline l < block) > 0) print l } NR >= from && NR <= to { next } { print }' "$CONFIG" > "$OUT"
    else
      if user_key_exists 0 0 "${tbl:-0}"; then
        echo "Always-on rule NOT written: ChatGPT's config already has a developer_instructions of your own, and DataBrain does not overwrite it. Nothing was changed."
        exit 3
      fi
      if [ -n "$tbl" ]; then
        # Above the comment lines that sit directly on top of the header, so a comment keeps pointing at its table.
        at="$(awk -v t="$tbl" '{ l[NR] = $0 } END { a = t; while (a > 1 && l[a - 1] ~ /^[ \t]*#/) a--; print a }' "$CONFIG")"
        awk -v at="$at" -v block="$BLOCK" 'NR == at { while ((getline l < block) > 0) print l; print "" } { print }' "$CONFIG" > "$OUT"
      else
        cp "$CONFIG" "$OUT"
        if [ -s "$OUT" ] && [ "$(tail -c 1 "$OUT" | wc -l | tr -d ' ')" = "0" ]; then printf '\n' >> "$OUT"; fi
        cat "$BLOCK" >> "$OUT"; printf '\n' >> "$OUT"
      fi
    fi
    keep_ending
    if cmp -s "$CONFIG" "$OUT"; then echo "Always-on rule: already in place"; exit 0; fi
    if [ "$NO_BACKUP" = 0 ]; then cp -p "$CONFIG" "$CONFIG.databrain-backup-$(date +%Y%m%d-%H%M%S)" || { echo "Always-on rule NOT written: could not back up the config first." >&2; exit 2; }; fi
    cat "$OUT" > "$CONFIG" || exit 2
    echo "Always-on rule: written"
    exit 0 ;;
  remove)
    [ -f "$CONFIG" ] || exit 0
    range="$(block_range)"
    [ -n "$range" ] || { echo "Always-on rule: nothing to remove"; exit 0; }
    set -- $range
    awk -v from="$1" -v to="$2" 'NR >= from && NR <= to { skip = NR; next } skip && NR == skip + 1 && $0 == "" { skip = 0; next } { print }' "$CONFIG" > "$OUT"
    keep_ending
    if [ "$NO_BACKUP" = 0 ]; then cp -p "$CONFIG" "$CONFIG.databrain-backup-$(date +%Y%m%d-%H%M%S)" || { echo "Always-on rule NOT removed: could not back up the config first." >&2; exit 2; }; fi
    cat "$OUT" > "$CONFIG" || exit 2
    echo "Always-on rule: removed"
    exit 0 ;;
  *) echo "usage: always-on-rule.sh write|remove|check <config.toml>" >&2; exit 2 ;;
esac
