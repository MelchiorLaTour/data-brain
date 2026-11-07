# Data Brain — a no-copy second brain for LLM & AI agents

A personal knowledge index that lets an AI agent
search, read, and honestly abstain over YOUR notes without moving or editing the originals.
It stores derived search data, including extracted text, in its own working folder. The
terminal engine uses bash and sqlite FTS5 without a model call or network connection.

## Download for Claude Desktop (macOS)

**What DataBrain will not read:**

- Folders named `Resources/Sensitive`, `.git`, `node_modules`, `.obsidian`, `.ssh`, `.gnupg` and `.aws`, and any file that is not `.md`, `.txt`, `.pdf`, `.docx`, `.doc`, `.pages` or `.rtf`.
- Names are checked first, then text is checked on your Mac. Nothing is sent.
- Anything that looks private is held back until you say it is fine: taxes, bank, ID, medical, payslips, passwords, keys, contracts, in English and French, and any text with an IBAN, card number, social security number or private key.
- Scanned images such as `IMG_2231.jpg` are not checked.

**Do this:**

1 → Download **[databrain.mcpb](https://github.com/MelchiorLaTour/data-brain/releases/latest/download/databrain.mcpb)**.  
2 → Open **Claude → Settings… → Extensions**. (**Extensions** is in the left list, under **This computer**.)  
3 → Click **Advanced settings**.  
4 → Click **Install extension**. (Bottom of the page, under **Extension developer**.)  
5 → In the window that opens, click **databrain.mcpb**, then click **Open** at the bottom right. (It is in **Downloads**, in the left list. If your Mac added a number to the name, such as **databrain (1).mcpb**, click that one. If the next page says **Update** instead of **Install**, DataBrain was installed before. Uninstalling does not clear its saved folder list, so check that list in step 7 either way.)  
6 → Click **Install**. (The **Configure DataBrain** window opens next.)  
7 → Click **Add directory**, then the **folder icon**, and pick **Desktop**. Do it again for **Documents**, then **Downloads**. Nothing gets moved. Add one more directory for every other top-level folder you want searched (see footnote 1). These are all the folders your DataBrain can read. Sensitive information is held back and left untouched during setup. (Under **Folders DataBrain can read**, click **Add directory**. An empty row appears. Click the **folder icon** at the right end of that row. A Mac window opens. On its left, under **Favorites**, click **Desktop**, then click **Open** at the bottom right. Do the same with **Documents**, then **Downloads**. A folder is not in the list? Click the house icon with your name, double-click the folder, then click **Open**. Folders from an earlier install can still be listed, even after you uninstalled: remove any folder you do not want with its **X**. If you close the window by mistake: **Claude → Settings… → Extensions → DataBrain → Configure**.)  
This section should look somewhat like this:  
![The Configure DataBrain window. Under Folders DataBrain can read there are four rows: /Applications, /Users/User/Downloads, /Users/User/Desktop and /Users/User/Documents, each with a folder icon and an X, then an Add directory button, and Cancel and Save at the bottom. Your own user name appears instead of User.](Mac%20download/Claude%20app/configure-example.png)  
8 → Click **Save**. Then click the **Disabled** switch so it reads **Enabled**, and close the window with the **X** at the top right. (Click Save first: once the switch reads **Enabled**, there is no Save button to click.)  
9 → Check that DataBrain loaded. Close Settings completely, then open **Claude → Settings… → Extensions** again: **DataBrain** should be listed. Then open a new chat, click the **+** sign in the message box, click **Connectors**, and check that **DataBrain** is switched on. (You may need to scroll through your connectors.)  
10 → In a new chat, send this message: `Set up my DataBrain` (Claude shows you the folders DataBrain will read, in the chat. Check each one, then say **yes**. If a folder is wrong, say **no**, open **Claude → Settings… → Extensions → DataBrain → Configure**, remove it with its X, then send the message again. Claude may list files that look private and ask which are fine to index. If you are not sure, say **none**. When Claude asks to use DataBrain, we recommend **Always allow**: people approve almost every permission prompt anyway, [Anthropic found 93% of prompts are approved](https://www.anthropic.com/engineering/claude-code-auto-mode).)  
11 → When your Mac asks to let Claude access your Desktop or Documents folder, click **OK** (or **Allow**). (It can appear while Claude sets up. Documents, Desktop, Downloads, iCloud Drive, and external drives each ask once.)  
12 → When Claude says DataBrain is set up, tell Claude how to use it: open **Claude → Settings…**, click **Account** in the left list, and find the big text box named **Instructions for Claude** at the bottom of the **Profile** section. If the box already has text, keep all unrelated instructions. Replace any older DataBrain instruction with this line; if none is present, click at the end of the text, press **Return** twice, then paste it. If the box is empty, just paste it:  
`For ANY question about me (I, my, me, my life, work, hobbies, plans, or anything I keep or wrote), call databrain_search FIRST, even when general knowledge could answer it; general knowledge is not "memory". Start the answer with "From your files:" and where it comes from; if the answer does not come from DataBrain, start with "From general knowledge:". If DataBrain finds nothing, say so before falling back.`  
Then open a **new chat** and send the question DataBrain gave you.

**Footnote 1: which folders to add.** *For people who know computers:* adding a directory gives DataBrain read access to that folder and everything under it, including all subfolders. Add the top-level (parent) folders you want searched, such as the ones in your Finder **Favorites** list: **Desktop**, **Documents**, **Downloads**. You do not need to add their subfolders. Do not add your whole home folder: DataBrain refuses it. *Like you are five:* a folder is a box. A small box holds a few papers. A big box holds lots of little boxes. If you pick a big box, DataBrain looks inside all the little boxes in it too, so you do not have to pick each little box. But a big box like **Documents** has everything in it, even papers you may not want. If you only want one little box, pick just that one.

That's all. You can delete the downloaded file now. It is in your **Downloads** folder. DataBrain lives in your home folder: **Finder → Go → Home**.

To remove DataBrain: **Claude → Settings… → Extensions**, then on the **DataBrain** row click the **⋯** button (to the right of **Configure**) and click **Uninstall** (red). Your own files are never touched. DataBrain's folder stays on your Mac, in your home folder (**Finder → Go → Home**), named **DataBrain**, or **DataBrain 2** and so on. It holds copies of the text DataBrain read, so drag it to the Trash if you want that gone. Same steps with copy buttons: [app guide](Mac%20download/Claude%20app/databrain-app-guide.html).

Files kept in iCloud, OneDrive, Google Drive and Dropbox have not been tested yet. The terminal route for Claude Code is in [INSTALL.md](INSTALL.md); test status is in the [acceptance ledger](setup/ACCEPTANCE.md).

## Compatibility

The terminal setup targets Claude Code on macOS. A separate Claude Desktop extension is
published as a release; the acceptance ledger above records what has been tested. Its package,
setup flow, tests, and current limits are described in
[setup/README.md](setup/README.md). [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) describes
the older terminal integration; use the acceptance ledger above for the extension's status.

### OpenAI clients

The intended novice route is to paste [this repository link](https://github.com/MelchiorLaTour/data-brain)
into ChatGPT desktop's Codex view and ask it to download and set up DataBrain. **That route
is not available yet:** the local Codex bundle is not a signed public download and has not
passed physical ChatGPT desktop or CLI acceptance. The local server requires a Codex Local
chat in a local project; ordinary Chat/Quick chat and ChatGPT Work do not provide this local
MCP route. Codex auto-discovers `AGENTS.md` from the primary local-project folder, so a pasted
GitHub URL alone does not attach the repository or load its instructions. The first-turn
clone/read/bootstrap handoff is unverified, and this project-selection step means the strict
"paste one link into any ChatGPT chat" target is not met yet. Review the
[ChatGPT desktop guide](setup/codex/CHATGPT-DESKTOP.md),
[Codex CLI guide](setup/codex/CLI.md), and
[Codex acceptance ledger](setup/CODEX-ACCEPTANCE.md) for current limits.

## Architecture

## Use visualization

![Use visualization](docs/assets/use-visualization.png)

```mermaid
flowchart LR
    subgraph roots["Canonical roots (bin/canon.sh)"]
        A["~/Notes"] ; B["~/Documents"] ; C["~/Downloads"]
    end
    roots -->|"ingest-root.sh (no copies)"| I["moc/index.tsv\npath · title · themes · keywords\n(label source of truth)"]
    I -->|label-by-path.sh| I
    I -->|build-fts.sh| F["fts.db (sqlite FTS5, BM25)"]
    roots -->|"extract.sh (pdf/docx/offloaded → text sidecars)"| X["moc/extracted/"]
    I -->|rebuild.sh| M["moc/rooms/ + INDEX.md\n(derived, rebuildable)"]
    F --> S1["fts.sh — ranked search"]
    S1 --> S2["look.sh — snippet read"]
    S2 --> S3["open the note (only to quote/confirm)"]
    S1 -.-> AB["abstain-check.sh\nroute → read → judge\n→ answer or 'not in the brain'"]
```

The search ladder is the point: **read-less-first**. The agent scans ranked hits, reads cheap
snippets from the extract tier, and only opens a full note to quote it. `DOCTRINE.md` is the
behavioral half — when to search, how to decompose a question into tight keywords, and when to
honestly say "not in the brain" instead of guessing.

## Philosophy

- **Original files stay in place.** The brain is an *access layer*: an index of labels and
  derived search text pointing at canonical paths. Delete the generated brain data, and the
  original files remain in their folders.
- **Never move or rename a Finder-visible file.** Labels live in `moc/index.tsv`, not in your
  folder structure. Organizing = editing a TSV row, not dragging files.
- **Agent-OFF engine.** Everything in `bin/` is pure bash + ripgrep + sqlite. It runs cold, in
  any terminal, with no model in the loop. The model supplies judgment (query decomposition,
  abstain decisions, synthesis), never plumbing.
- **Honest abstention over forced matches.** `⚠ WEAK MATCH` output is the mechanical basis for
  answering "that's not in the brain" — the failure mode this system was built to kill is an
  agent confidently answering about your notes without ever looking.

## What's in the box

| Piece | What it does |
|---|---|
| `bin/canon.sh` | **EDIT template** — your canonical roots + prune lists + artifact ignore list |
| `bin/ingest-root.sh`, `build-index.sh` | walk roots, append new files to `index.tsv` (dedup, no copies) |
| `bin/label-by-path.sh` | **EDIT template** — folder → room mapping, fills unlabeled rows only |
| `bin/extract.sh` | plaintext sidecars for PDFs/docx/iCloud-offloaded files (800KB body cap) |
| `bin/build-fts.sh`, `fts.sh` | sqlite FTS5 build + BM25-ranked search |
| `bin/look.sh` | ranked hits + capped snippets — the primary read path |
| `bin/abstain-check.sh` | 2–3 query variants → routing hint (CONVERGENT/MIXED/DIVERGENT/DRY) |
| `bin/search.sh` | exact-phrase regex fallback over live note bodies |
| `bin/refresh.sh` | one-command freshness pass (ingest → label → extract → rebuild → FTS) |
| `bin/rebuild.sh` | redraw derived room MOCs from the index |
| `bin/compile-room.sh`, `stale-wikis.sh`, `room-stamp.sh` | on-demand room wikis + anti-rot stamps |
| `bin/capture.sh`, `file-note.sh`, `index-add.sh`, `synth-save.sh` | capture + write-back paths |
| `bin/lint.sh`, `recent.sh`, `inbox-status.sh`, `reach-map.sh` | health + maintenance |
| `bin/delete-candidates.sh`, `verify-dupes.sh` | LIST-ONLY cleanup reports (never delete anything) |
| `bin/brain-digest.sh`, `register-digest-hook.sh` | SessionStart priming digest (Claude Code hook) |
| `bin/expand.sh`, `backfill-*.sh`, `label-container-types.sh`, `kw-dict.tsv` | optional/experimental — headers state what was measured, incl. negative results |
| `DOCTRINE.md` | the agent-side access doctrine (load into your agent's context) |
| `templates/` | MAP skeleton + discovery-hook trigger rows |
| `install.sh` / `verify-install.sh` | one-command bootstrap + machine-checked acceptance gates |

## Documentation

| Doc | What's in it |
|---|---|
| [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md) | the deep walkthrough: index anatomy (index.tsv, fts.db, extracts), the read-less-first search ladder with real commands, the labeling misc-trap, why the doctrine exists |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | full platform matrix: agent platforms, operating systems, the exhaustive macOS-only list, dependencies |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | sandbox-tested failure modes: installer refusals, verify-install output interpretation, empty search results, labeling and refresh pitfalls |
| [DOCTRINE.md](DOCTRINE.md) | the agent-side access doctrine — the behavioral half, loaded into your agent's context |
| [INSTALL.md](INSTALL.md) | the hybrid bootstrap: install.sh does the deterministic work, one agent step authors your taxonomy |
| [docs/MIGRATION.md](docs/MIGRATION.md) | AI-readable setup, relationship pass, four-stratum recall gate, and safe Obsidian migration |

## Use cases

- You keep notes as plain files (Markdown, PDFs, docx) scattered across real folders and want
  your coding agent to answer "what do I know about X?" from them — without a migration.
- You want **honest** retrieval: "not in the brain" as a first-class answer, not hallucinated
  recall.
- You want capture → label → find with zero vendor lock-in: the whole state is one TSV + one
  rebuildable sqlite file.

## When NOT to use this

- **You want semantic/embedding search.** Deliberately absent. The author evaluated a local
  embedding model against this corpus and **rejected it**: portability cost (Python + model
  weights vs. pure bash) outweighed measured gains, and query decomposition by the agent closed
  most of the gap. If your notes need conceptual similarity search, use a vector tool instead.
- **You have under a few hundred notes.** Just grep. This earns its keep at ~1,000+ files
  spread over messy roots.
- **Your notes live in cloud apps** (Notion, Evernote, Apple Notes without export). The engine
  indexes *files on disk*. Export first or look elsewhere.
- **You require a physically verified Claude Desktop extension.** The extension has
  been tested on one Mac only (see the acceptance ledger above).

## If DataBrain stops working

After a restart, an update or a folder problem, send Claude `Run DataBrain repair`. If a folder was replaced
(restored from a backup, moved by iCloud), send `Re-approve my folder <name> in DataBrain`. Repair fixes what is
safe to fix, runs the install checks and reports what is still wrong. It never deletes, renames or moves your
files or the DataBrain folder, and never adds a folder. Without Claude: turn the extension on in
Claude → Settings… → Extensions → DataBrain, allow the folders in System Settings → Privacy & Security →
Files & Folders, or install the file again and pick your folders again (the existing brain is reused;
tested with the extension and its settings removed). Menu names were not re-checked on a Mac for this version.

## Security notes

- The terminal engine makes **no network calls**; it reads your files and writes only inside
  its own `moc/` directory (plus capture destinations you configure). The separate Desktop
  extension's optional install audit requests public GitHub release metadata without sending
  document content.
- `canon.sh` prunes a `Resources/Sensitive/` path by default — keep credentials/secrets in one
  hard-blocked folder and the index never sees them. Pair with a PreToolUse hook that refuses
  agent reads of that path (pattern in the companion claude-optimization repo).
- `delete-candidates.sh` and `verify-dupes.sh` are LIST-ONLY by design: nothing in this repo
  deletes, moves, or renames your files. The riskiest write anywhere is appending a TSV row.
- Review any hook before registering it: hooks run arbitrary shell in your session.

## Portability

Claude Code is the supported and tested target today; everything below is the honest
future-portability story (details and per-platform status: [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)).

- **Engine:** any machine with bash, ripgrep, and sqlite3 (macOS out of the box; note
  `ls -lO`-based iCloud-offload detection is macOS-specific — harmless elsewhere).
- **Agent:** any model that can run shell commands can in principle drive the full ladder —
  Codex-style CLIs, open-weights models in an agent harness (untested). `DOCTRINE.md` is
  plain markdown; paste it into any agent's context.
- **Claude Code-specific:** only the SessionStart digest hook wiring
  (`register-digest-hook.sh`) and the discovery-hook trigger rows in `templates/`. The
  *pattern* (prime each session with a bounded map + access line) ports to any harness with
  session-start hooks.

## Measured results — author-measured, N=1, on his corpus

These numbers come from the author's own ~1,650-note corpus and have not been independently
reproduced; treat them as existence proofs, not benchmarks.

- Room-wiki A/B (compiled wiki vs. raw search, 30 questions): **28 wins / 0 losses / 2 ties**
  for the wiki, with **~43% fewer tool calls**.
- Trap-honesty eval (10 questions whose answers are NOT in the corpus): **10/10 honest
  abstentions** using the route→read→judge ritual, 0 false abstentions on answerable controls.
- Corpus-hygiene pass (labels + keywords + extracts): cold-start hits@3 **55% → 64%**.
- Mechanical query expansion (`expand.sh`) was measured to HURT ranked retrieval and is shipped
  disconnected, as a documented negative result.

## Install

The Claude Desktop extension is available from the
[latest release](https://github.com/MelchiorLaTour/data-brain/releases/latest). Its
intended first-run flow is one `.mcpb` download, installation through Claude Desktop's
Extensions settings, and a new chat with **“Set up my DataBrain.”** Tested on a real Mac in
Claude Desktop: install, setup on real folders, search, note capture and the health check. Not
tested yet: a reboot after install and iCloud moving Desktop & Documents. See
[setup/README.md](setup/README.md) for package and test status.

The established terminal installation is two layers:

1. **`./install.sh`** [no LLM needed] — checks dependencies (ripgrep, sqlite3), walks you
   through picking your note roots, builds the index and the ranked-search database, and
   smoke-tests a query. It deliberately leaves every row **unlabeled**: the labeler only ever
   fills unlabeled rows, so stamping default labels before your real folder→room mapping
   exists would make that mapping permanently ineffective.
2. **Hand `INSTALL.md` to your agent** — the one step that needs judgment: it proposes your
   room taxonomy from your real folders, confirms it with you, writes the mapping, and labels
   the index.

Run `bash verify-install.sh` anytime for a machine-checked PASS/FAIL of the whole install.

## License

MIT — see [LICENSE](LICENSE).
