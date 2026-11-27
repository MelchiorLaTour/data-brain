# DataBrain in ChatGPT desktop

This guide covers the local MCP route in the **Codex view, running a Local chat in a local
project**. It does not apply to ordinary Chat/Quick chat, ChatGPT Work, ChatGPT web, or a
Codex Cloud chat. OpenAI documents that Local chats run on the user's computer, while
ChatGPT's regular projects and Quick chats do not provide local-folder access. The desktop
app and Codex CLI share MCP configuration; the documented UI route is Settings → MCP servers
→ Add server → STDIO → Save → Restart ([Codex environments](https://learn.chatgpt.com/docs/environments/modes),
[Projects and chats](https://learn.chatgpt.com/docs/projects),
[OpenAI MCP guide](https://learn.chatgpt.com/docs/extend/mcp)).

## Project context for the one-link request

OpenAI says Codex automatically discovers `AGENTS.md` from the primary folder of the active
local project. Pasting a GitHub URL into a chat does not attach the remote repository or make
it the local project. To honor the one-link request from a fresh Codex Local chat, the agent
must first fetch the repository into its writable project, read its root `AGENTS.md` and
linked install guide, then run the verified bootstrap. A client who starts in ordinary
Chat/Quick chat has no local MCP or local-folder route for this package and must switch to a
Codex Local project first. This project-selection and first-turn handoff means the strict
"paste one link into any ChatGPT chat" target is not yet met or physically proven. Do not say
that repository instructions were automatically loaded from the URL
([AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[local projects](https://learn.chatgpt.com/docs/projects?surface=app)).

These steps describe the current macOS candidate and require macOS 14 or later, on either
Apple Silicon or Intel. That is the current ChatGPT desktop requirement. The project's
supported operating-system scope is still awaiting a decision; no Windows bundle is
available ([OpenAI system requirements](https://help.openai.com/en/articles/9395554-what-are-the-system-requirements-for-the-chatgpt-macos-app)).

## Release status

**There is no current signed public DataBrain Codex download. Do not treat this repository
link or its local candidate ZIPs as a client installer.** The source-matched packages remain
unsigned test bundles, and the physical desktop setup has not passed acceptance. See the
[Codex acceptance ledger](../CODEX-ACCEPTANCE.md).

The steps below describe the intended client flow after a reviewed, signed release is
available. They are not evidence that the flow has been tested in ChatGPT desktop.

## Intended one-link setup

After a signed stable release and desktop acceptance exist, the novice flow is to open
ChatGPT desktop's **Codex** view and send:

> Download and set up DataBrain from https://github.com/MelchiorLaTour/data-brain

The local agent should inspect the repository's install instructions, run the verified
bootstrap, and ask you to approve the download/install and shared MCP configuration change.
The bootstrap uses the Codex executable in `PATH` or the ChatGPT desktop app's bundled
Codex executable when available. OpenAI documents that executable at
`/Applications/Codex.app/Contents/Resources/codex` for version checks; DataBrain's use of it
for MCP registration still requires physical acceptance. The app must restart to load the
new server. `/mcp` lists connections, but only a real DataBrain search/read call proves it
works ([OpenAI MCP guide](https://learn.chatgpt.com/docs/extend/mcp),
[ChatGPT desktop troubleshooting](https://learn.chatgpt.com/docs/reference/troubleshooting)).

This is the intended flow, **not a working client download today**. There is no signed stable
release, and the desktop bootstrap, restart, and setup flow have not been physically tested.

## Set up the local brain

After restart, ask **“Set up my DataBrain.”** DataBrain asks you to choose the source folders,
choose where to create the DataBrain folder, and approve one exact-scope disclosure before it
reads source contents. Keep the source folders and destination separate.

After approval, the local worker indexes only those selected folders and writes generated
state only to the approved DataBrain folder. It leaves originals in place. The model sees
paths and only the excerpts you deliberately ask DataBrain to read; those excerpts become
part of the hosted conversation. DataBrain does not ask for your ChatGPT account profile or
an API key.

The product goal is to finish a client-scale setup in 2–4 hours while requiring the user for
only the initial 15–30 minutes. That is a target, not a measured duration or guarantee. The
Codex desktop flow has not yet been checked for native dialogs, continued work after the app
closes, restart recovery, or answer quality.

## If setup pauses or reports an issue

- Ask the chat for `databrain_setup_status` and follow the stage-specific next step.
- If the destination was moved or replaced, reconnect through the folder chooser. DataBrain
  does not silently choose a new destination.
- If a source folder changed or access was revoked, approve the new scope before retrying.
- Do not call the brain ready until `databrain_verify_install` reports the local checks and
  a known question returns evidence that can be read. An absent question should remain
  unanswered when the approved sources contain no evidence.
- Report any failure with the macOS version, ChatGPT desktop version, package version, and
  the exact setup stage. Do not include private source excerpts in a support report.
