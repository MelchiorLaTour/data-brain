# DataBrain Codex bundle (local candidate)

This macOS app bundle runs the shared DataBrain MCP server with pinned local Node and
ripgrep binaries. It does not include source documents or a prebuilt personal index. The
ChatGPT desktop route requires macOS 14 or later, on Apple Silicon or Intel.

## Choose the OpenAI client surface

The intended local-data route is the **Codex view in the new ChatGPT desktop app**. The
app has separate ChatGPT and Codex views; OpenAI describes Codex as the surface for local
files, repositories, terminals, and developer tools ([desktop app overview](https://help.openai.com/en/articles/20001276-moving-to-the-new-chatgpt-desktop-app)).
DataBrain's local STDIO server and selected-folder indexing are designed for that local
runtime. The user's model orchestrates setup and answers; indexing and retrieval run locally,
without a separate model API key.

Do not give users ChatGPT Chat/Work setup steps as if they install this local server.
OpenAI's current custom-app docs say ChatGPT connects to remote MCP servers, not a local
STDIO process. A private local server can be connected through Secure MCP Tunnel, but that
would be a different deployment and privacy boundary. Tunnel setup requires a tunnel ID,
a runtime API key for the local tunnel client, and the relevant Platform/workspace permissions.
OpenAI currently limits full MCP write/modify support to Business, Enterprise, and Edu;
Pro supports read/fetch only, which is insufficient for DataBrain's local index creation
([custom MCP app guidance](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt),
[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)).

**DataBrain's desktop installation remains unverified.** OpenAI documents local STDIO MCP in
the ChatGPT desktop app's Codex view and says its MCP configuration is shared with Codex CLI
and the IDE extension ([OpenAI MCP guide](https://learn.chatgpt.com/docs/extend/mcp)). We
have not verified DataBrain registration in the running app, restart behavior, or the
first-run flow. The current bootstrap uses `codex mcp add` and has not been run against a
real release or a clean client Mac. Do not tell clients that a GitHub link alone installs
DataBrain until physical acceptance passes.

For a local install candidate, the user must approve package installation and the local MCP
configuration change. DataBrain separately asks them to choose source folders and a
destination, then shows one exact-scope approval before reading source contents. Local
indexing leaves originals in place; only paths and excerpts deliberately returned to the
model enter the conversation. Computer Use screen/accessibility permissions are not a
substitute for these file-scope grants and are not required by this local MCP package.

The current local build is unsigned and is not a public download. Do not bypass macOS
quarantine or security prompts. Public release requires independent build review, signing,
notarization where required, and a download/install acceptance run.

## Bootstrap script (macOS candidate)

`setup/codex/bootstrap.sh` selects the latest stable Codex release for the Mac's
architecture, checks its published ZIP checksum, release build record, embedded payload
hashes, source commit and tag binding, code signature, and Gatekeeper assessment. It
installs into `~/Applications` and registers the `databrain` MCP entry through
`codex mcp add`. An existing entry is accepted only when its exact STDIO command points to
this managed bundle path with no extra arguments, environment, or working directory. A
different entry is preserved and rejected. A different installed release at that path is
replaced only after its package, signature, and Gatekeeper checks pass; the new bundle is
staged beside it, verified after replacement, and the prior app is restored if a post-install
check fails. The DataBrain locator, generated index, and original source files remain outside
the app bundle. Rerunning with the exact same verified release is a no-op.

The bootstrap uses a local Codex CLI in `PATH`, or checks the ChatGPT desktop app's bundled
Codex executable at the standard app locations. OpenAI documents
`/Applications/Codex.app/Contents/Resources/codex` as its bundled executable for version
checks; DataBrain's use of that executable for MCP registration remains unverified in the
running app ([ChatGPT desktop troubleshooting](https://learn.chatgpt.com/docs/reference/troubleshooting)).
The user approves the install command and shared configuration change. The script is not a
public installer yet: no stable signed Codex release exists, and the bootstrap has not been
run against a clean client Mac.

New bundles declare macOS 14.0, matching ChatGPT desktop's published minimum. The pinned
Node v24.21.0 executable itself declares macOS 13.5.0; bundle tests check that the app's
declared minimum is not below the runtime minimum. Neither check substitutes for installation
on a clean macOS 14 machine ([OpenAI system requirements](https://help.openai.com/en/articles/9395554-what-are-the-system-requirements-for-the-chatgpt-macos-app)).

## Expert CLI route

See the separate [Codex CLI guide](CLI.md) for the registration, first-run, and recovery
steps. For ChatGPT desktop, use the [Codex-view guide](CHATGPT-DESKTOP.md).

After extracting and installing the bundle, add its executable with the documented Codex
command:

```sh
codex mcp add databrain -- "/Applications/DataBrain MCP.app/Contents/MacOS/databrain-mcp"
codex mcp list
```

OpenAI documents that ChatGPT desktop's Codex view shares MCP configuration with Codex CLI
and supports local STDIO servers. That documents the intended route; it does not prove that
DataBrain loaded or completed a real tool call. Verify search, read, and abstention in the
running app ([OpenAI MCP guide](https://learn.chatgpt.com/docs/extend/mcp)).
