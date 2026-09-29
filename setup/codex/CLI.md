# DataBrain with Codex CLI

This is the expert setup path for a local DataBrain MCP bundle. It uses Codex's documented
`codex mcp` commands; the ChatGPT desktop app, Codex CLI, and IDE extension share the same
MCP configuration ([OpenAI MCP guide](https://learn.chatgpt.com/docs/extend/mcp)).

These steps describe the current macOS candidate. The project's supported operating-system
scope is still awaiting a decision; no Windows bundle is available.

## Before you start

**No signed public Codex release is available yet.** Use these instructions only with a
reviewed release or an explicitly approved local test build. A local ZIP or a server entry
is not proof that the client has loaded DataBrain. See the
[Codex acceptance ledger](../CODEX-ACCEPTANCE.md).

The released bundle includes its Node and ripgrep runtimes. Do not install a separate runtime
or point Codex at a repository checkout.

## Register the server

1. Install the released `DataBrain MCP.app` bundle.
2. Check for an existing entry before changing the shared Codex configuration:

   ```sh
   codex mcp get databrain
   ```

   If an entry already exists, inspect it and resolve it deliberately; do not overwrite a
   different server.

3. Register the bundle executable:

   ```sh
   codex mcp add databrain -- "$HOME/Applications/DataBrain MCP.app/Contents/MacOS/databrain-mcp"
   ```

   If the app is installed in `/Applications`, use that exact path instead. This command
   changes the user's Codex MCP configuration.

4. Confirm the entry and start a new Codex session:

   ```sh
   codex mcp list
   codex mcp get databrain
   ```

5. In the Codex TUI, use `/mcp` to inspect active servers, then ask **“Set up my DataBrain.”**
   Follow the source chooser, destination chooser, and exact-scope approval. The background
   worker continues after approval; check `databrain_setup_status` for progress and
   `databrain_verify_install` before calling setup complete.

To remove only the server registration, run `codex mcp remove databrain` ([Codex developer
commands](https://learn.chatgpt.com/docs/developer-commands)). This leaves the
installed app, approved DataBrain destination, generated index, and original source files in
place. Review the exact configuration entry before removing it.

## Scope and recovery

The first approval covers reads under the selected source roots and generated writes under
the selected DataBrain destination. It does not authorize a whole-home scan or changes to
original files. Search paths and excerpts deliberately returned by `databrain_read` enter the
Codex conversation.

If setup stops, ask for `databrain_setup_status`; resume only after resolving its reported
cause. If the approved destination identity changed, reconnect it through the supported
chooser. Do not edit DataBrain state files or reuse an unknown folder as a destination.

The CLI model-to-MCP route has not passed physical acceptance in this environment. A
successful `codex mcp list`, `get`, or `/mcp` display is preliminary configuration evidence,
not proof of source setup, search, read, or abstention.
