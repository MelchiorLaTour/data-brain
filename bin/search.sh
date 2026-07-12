#!/usr/bin/env bash
# search.sh — ripgrep the CANONICAL homes + the house. Works with Claude OFF.
# Access-not-store: NewBrain holds NO copies. We search content where it already
# lives (the vault piles, Main inline memory, every project's FACTS) so nothing is
# duplicated. Plain text in, plain matches out.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Canonical pile roots come from the shared list (bin/canon.sh) so search + rebuild agree.
source "$ROOT/bin/canon.sh"
# Claude Code's per-$HOME memory dir (dir name = $HOME with '/' -> '-'); derived, never hardcoded.
HOUSE_MEM="$HOME/.claude/projects/$(printf '%s' "$HOME" | tr '/' '-')/memory"
Q="${*:-}"
if [ -z "$Q" ]; then
  echo "usage: search.sh \"query\"" >&2
  exit 1
fi
# Find a REAL ripgrep BINARY. `command -v rg` is unreliable here: in Claude Code, `rg` is a shell
# FUNCTION (a wrapper that routes through the claude binary), so it exists interactively but NOT in
# scripts, and depending on it would break the "works with Claude OFF" invariant. `type -P` returns
# only an executable file on PATH (never a function); we also probe the usual install + vendored spots.
RG_BIN="$(type -P rg 2>/dev/null || true)"
if [ -z "$RG_BIN" ]; then
  for cand in /opt/homebrew/bin/rg /usr/local/bin/rg /usr/bin/rg "$HOME/.cargo/bin/rg" \
              "$HOME"/Claude/*/node_modules/@anthropic-ai/claude-agent-sdk/vendor/ripgrep/arm64-darwin/rg; do
    [ -x "$cand" ] && { RG_BIN="$cand"; break; }
  done
fi

# Capture results, then decide by whether output is non-empty — NOT by exit code. grep/rg over the
# widened corpus return non-zero (code 2) when some Desktop files are unreadable, even WITH matches;
# keying the "no matches" message off exit status would fire it spuriously. `|| true` keeps set -e happy.
# MAIN PASS — full-text over LOCAL text notes only; iCloud-offloaded files filtered OUT first.
# Why: reading a dataless original forces a macOS DOWNLOAD; extract.sh re-evicts offloaded notes back
# to dataless, so an unfiltered search would re-download them every run (a storm) and fight the evict.
# We never open a dataless original — its text is reached via its moc/extracted/ sidecar (next pass).
# Enumerate (rg's fast walk, or find without rg); both honor canon.sh prune. `stat` is metadata-only.
if [ -n "$RG_BIN" ]; then
  # PRUNE_RG must come AFTER the extension whitelist: rg gives LATER globs precedence, so a
  # trailing -g '*.md' would override the ignore list's basename negatives (measured 2026-07-05:
  # artifact exclusion silently failed in the old order).
  cand="$("$RG_BIN" --files -g '*.md' -g '*.txt' -g '*.markdown' "${PRUNE_RG[@]}" "${CANON[@]}" "$HOUSE_MEM" 2>/dev/null || true)"
else
  cand="$(find "${CANON[@]}" "$HOUSE_MEM" -type f \( -name '*.md' -o -name '*.txt' -o -name '*.markdown' \) "${PRUNE_FIND[@]}" 2>/dev/null || true)"
fi
# Post-filter the candidate list shell-side: rg silently ignores multi-component anchored globs
# (measured 2026-07-05 — '!**/NewBrain/**' left 1080 Desktop/NewBrain files in the corpus), so
# self-index + Games exclusion is enforced here deterministically instead of via rg globs.
[ -n "$cand" ] && cand="$(printf '%s\n' "$cand" | grep -v -e '/NewBrain/' -e '/Games/' || true)"
# One bulk `stat` (not one fork per file): keep only files whose flags do NOT include 'dataless'.
# Flags (%Sf) are space-free (e.g. '-' or 'compressed,dataless'), so $1 is the flags, rest is the path.
local_files=""
[ -n "$cand" ] && local_files="$(printf '%s\n' "$cand" | tr '\n' '\0' \
  | xargs -0 stat -f '%Sf %N' 2>/dev/null | awk '$1 !~ /dataless/ { sub(/^[^ ]+ /,""); print }' || true)"
# Search ONLY the local survivors (decide by non-empty output, not exit code — see note below).
out=""
if [ -n "$local_files" ]; then
  if [ -n "$RG_BIN" ]; then
    out="$(printf '%s\n' "$local_files" | tr '\n' '\0' | xargs -0 "$RG_BIN" -i -n --heading -C1 "$Q" 2>/dev/null || true)"
  else
    out="$(printf '%s\n' "$local_files" | tr '\n' '\0' | xargs -0 grep -inI -C1 "$Q" 2>/dev/null || true)"
  fi
fi
# Phase-1 extracts: derived plaintext of binary/offloaded notes (moc/extracted/). canon.sh prunes
# moc/** from the main corpus, so they get their own pass. Each extract's first line names its
# source file, so a hit traces back to the real PDF/docx/offloaded note.
EXTRACTED="$ROOT/moc/extracted"
if [ -d "$EXTRACTED" ]; then
  if [ -n "$RG_BIN" ]; then
    ex="$("$RG_BIN" -i -n --heading -C1 -g '*.txt' "$Q" "$EXTRACTED" 2>/dev/null || true)"
  else
    ex="$(grep -rinI -C1 --include='*.txt' "$Q" "$EXTRACTED" 2>/dev/null || true)"
  fi
  [ -n "$ex" ] && out="$out${out:+$'\n'}$ex"
fi
if [ -n "$out" ]; then
  printf '%s\n' "$out" | sed "s#$HOME#~#g"
else
  echo "no matches for: $Q"
fi
