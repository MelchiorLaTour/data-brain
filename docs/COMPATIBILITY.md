# Compatibility

**NewBrain is a Claude Code system for now.** The engine in `bin/` is agent-agnostic pure
bash, but everything that makes the system *feel* automatic — the SessionStart digest hook,
the discovery-hook trigger rows, the INSTALL.md agent bootstrap — is built and tested
against Claude Code. Other platforms range from "degraded but usable" to "not possible";
this page is the honest map.

## Agent platforms

| Platform | Status | What works / what doesn't |
|---|---|---|
| **Claude Code — CLI** | ✅ Supported, live-tested | Everything: engine, doctrine, digest hook, discovery rows, agent-run install. This is the environment the author runs daily. |
| **Claude Code — desktop app / IDE extensions** | ✅ Supported | Same harness as the CLI (same hooks, same shell access). |
| **Claude Desktop (the chat app)** | ⚠️ Degraded path only | No hooks, no plugins, no native shell. You'd need an MCP server that exposes shell execution, plus DOCTRINE.md pasted into the conversation/project instructions. Search works through that tunnel; the digest priming and auto-refresh wiring don't exist. Possible, not recommended. |
| **ChatGPT desktop app** | ❌ No | No local shell execution at all — the engine can't run. |
| **Codex CLI (OpenAI)** | 🔶 Untested, should work | The engine is plain bash, so any shell-capable agent CLI can drive the full search ladder. DOCTRINE.md is plain markdown — load it via AGENTS.md. Built-to-spec reasoning only; nobody has live-tested this path yet. |
| **Other shell-capable agent CLIs / open-weights harnesses** | 🔶 Untested, should work | Same reasoning as Codex: engine + doctrine port; the Claude Code-specific wiring (digest hook, trigger rows) needs a harness equivalent. |

The honest summary: **the engine ports anywhere bash runs; the *wiring* is Claude Code's.**
What you lose off Claude Code is the automation — session priming, staleness surfacing,
prompt-triggered discovery — not the core search-and-abstain capability.

## Operating systems

| OS | Status | Notes |
|---|---|---|
| **macOS** | ✅ Supported, live-tested | Development and test platform (stock bash 3.2, BSD awk — both explicitly supported). |
| **Linux** | 🔶 Should work, untested | Engine is POSIX-portable bash + `rg` + `sqlite3`. The macOS-only bits below degrade gracefully or need a swap. |
| **Windows — WSL** | 🔶 Should work, code-read only | All scripts are POSIX; the macOS-specific calls are optional-skip or have fallbacks (see below). Replace the launchd nightly job with a cron entry. Nobody has run this live. |
| **Windows — Git Bash** | ⚠️ Not recommended | No `sqlite3` bundled, converter tooling patchy. Use WSL instead. |
| **Windows — native (cmd/PowerShell)** | ❌ No | Everything is bash. |

### The macOS-only bits, exhaustively

- `launchd` nightly refresh (INSTALL.md Step 3) — **swap for cron** on Linux/WSL.
- `textutil` (docx→text in `extract.sh`) — macOS-only; the script **skips** docx conversion
  when it's absent (pandoc, if installed, is also tried).
- `ls -lO` iCloud-offload detection — macOS-only flag; the code path **never fires**
  elsewhere (no iCloud placeholders to detect).
- `id -F` (full-name lookup in install.sh) — macOS-only; **falls back to `$USER`**.
- `mdfind` (Spotlight fallback mentioned in DOCTRINE.md routing) — macOS-only; use
  `locate`/`fd` or skip.

Nothing else in `bin/` is platform-specific.

## Dependencies

Required: `bash`, `rg` (ripgrep), `sqlite3`. Optional (extract quality): `pdftotext`
(poppler), `textutil` or `pandoc` for docx. `install.sh` checks all of these and says
what's missing.
