# DataBrain repository instructions for Codex

When the user asks to download and set up DataBrain from this repository, use the local
Codex host in the ChatGPT desktop app unless the user specifies another supported surface.
Read `setup/codex/CHATGPT-DESKTOP.md` and `setup/codex/INSTALL.md` before acting.

## Installation

- Do not treat ChatGPT Work or ChatGPT web as a local MCP host. If the user is there, explain
  that this local STDIO package requires the ChatGPT desktop app's Codex host. A hosted app
  is a separate remote-MCP deployment.
- Check the public GitHub releases for a stable, architecture-matched DataBrain Codex release.
  If none exists, stop: do not install unsigned bundles from `setup/codex/dist/`, build a
  client package from this checkout, or claim that installation succeeded.
- When a stable release exists, run only `setup/codex/bootstrap.sh`. It verifies the release,
  checksum, source binding, signature, and Gatekeeper result before installing and registering
  the local MCP server. Never bypass macOS security checks.
- The user's request to install authorizes the described download, app installation, and
  `databrain` MCP registration. Report the exact app path and whether registration was added
  or preserved. Preserve any different MCP entry or app. An existing `databrain` entry may
  be updated only when its exact STDIO command points to the managed bundle path; bootstrap
  must verify the installed app, refuse downgrades, and restore it if update checks fail.

## First-run setup

- After installation, restart the ChatGPT desktop app and use its Codex host. Start
  `databrain_setup_start`; do not manually read or index files from the model session.
- Let the user choose source folders and the DataBrain destination in the native dialogs.
  Show the exact folders and scope, then request one approval before reading source contents.
  The approved run covers local indexing, taxonomy, relationship metadata, and verification.
- After approval, continue the local worker through `databrain_setup_status` and required
  stages without asking the user to remain present or re-approve the same scope. Ask again
  only if the user changes folders or the server reports that the saved identity or scope
  changed.
- Do not collect the ChatGPT account profile, credentials, or API keys. Index only selected
  files locally; do not copy or modify originals. Explain that paths and excerpts explicitly
  returned by `databrain_read` enter the hosted conversation.
- Say the brain is ready only after setup verification passes, a known query returns
  evidence that `databrain_read` can open, and an absent query abstains. Report any gaps and
  keep the status incomplete when a required check fails.
- Treat the 2–4 hour setup and 15–30 minute user-presence goals as targets, not guarantees;
  do not invent duration claims.
