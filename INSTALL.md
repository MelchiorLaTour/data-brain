# INSTALL — hybrid bootstrap

For a complete AI-executable migration from no existing brain or from Obsidian, read
[docs/MIGRATION.md](docs/MIGRATION.md) first. It defines the backup, verification, and
explicit-approval gates; this file is the installation procedure referenced by that guide.

Install is **hybrid**: one shell script does everything deterministic, and an agent step
handles the one thing that genuinely needs judgment — your room taxonomy. Steps marked
**[no LLM needed]** are plain shell you can run yourself.

Rules for the agent executing the agent steps:
- **Propose, never assume.** Taxonomy (rooms, mappings) is PROPOSED from the user's real
  files and CONFIRMED with the user before writing.
- **Never move, rename, copy, or delete a user file.** The engine's contract.
- **Session-state convention:** after finishing each step, append one line to
  `INSTALL-STATE.md` at the repo root — `step N — done — next: <step>`. If your session
  compacts or dies, the next session reads `INSTALL-STATE.md` and resumes from there.

Prerequisites: bash (3.2+, i.e. stock macOS), `rg` (ripgrep), `sqlite3` **built with FTS5**.
Scripts run under `bash` whatever your interactive shell is — run them (`./install.sh`), never
`source` them from zsh.

---

## Step -1 — preflight  [no LLM needed, seconds]

```
bash verify-install.sh --preflight "$HOME/My Vault"     # pass the roots you mean to index
```

Read-only go/no-go: dependencies, **whether your sqlite3 actually has FTS5** (it is a
compile-time option — a sqlite3 without it passes a plain `command -v` check and then fails
later at `build-fts.sh`), optional converters, clone writability, whether Obsidian is still
running, and per-root file counts. Advisory: `install.sh` does not require it to pass.

- **ACCEPTANCE:** prints `GO`.

## Step 0 — run the installer  [no LLM needed]

```
./install.sh
```

**Zero-prompt forms** — for any Obsidian vault, and whenever an agent, a script or CI is
driving. The interactive picker needs a terminal; with no terminal and no roots, `install.sh`
now exits naming these flags instead of reading EOF:

```
./install.sh --obsidian "$HOME/My Vault"           # single vault, no prompts, extract skipped
./install.sh --roots "$HOME/Notes" "$HOME/Docs"    # explicit roots, no prompts
./install.sh --roots "$HOME/Notes" --extract       # ...and run the slow extract pass now
./install.sh --help
```

Paths containing spaces work everywhere: quote them on the command line, or enter them through
the picker's "other" option, which reads one path per line.

It checks dependencies, walks you through picking your canonical roots (the directory trees
holding your notes), writes them into `bin/canon.sh`, builds `moc/index.tsv`, optionally runs
the binary-extract pass, builds the ranked-search index (`moc/fts.db`), and smoke-tests a query.

Every row is left deliberately **unlabeled ('-')**: the labeler only ever fills unlabeled rows,
so labels must not be stamped until YOUR mapping exists (that's Step 1). Junk-folder prunes can
be extended anytime via the `EDIT:` blocks in `bin/canon.sh`.

Each stage is appended to `INSTALL-STATE.md` under a `--- run <timestamp> ---` header, so an
interrupted run resumes from the last line instead of starting over.

- **ACCEPTANCE:** install.sh prints "smoke test: OK"; `bash verify-install.sh` shows only the
  0%-labeled WARN as its non-PASS line (8 PASS / 0 FAIL / 1 WARN).

## Step 1 — propose and write the room mapping  (the one real agent step)

- **GOAL:** replace the EXAMPLE mapping in `bin/label-by-path.sh` with the user's folder→room
  rules, then label the index.
- **DISCOVER:** `bash bin/label-by-path.sh --suggest` — it drafts the mapping from the user's
  real folders and prints it ready to paste, most-populated room first. It writes nothing and
  labels nothing, so the taxonomy step is REVIEWING a draft, not building one. If every note
  lands in one coarse room (a vault shaped `~/Vault/Areas/Career`), re-run with
  `--suggest 3`. The raw folder counts, if you want them:
  `cut -f1 moc/index.tsv | sed "s#$HOME##" | cut -d/ -f2-3 | sort | uniq -c | sort -rn`.
- **OUTPUTS:** propose a room taxonomy (aim for 5–20 rooms named after the user's life areas,
  not file types) + the awk mapping rows; on confirmation, edit the `room()` function — keep
  the final `return "-"` default. Then run:
  `bash bin/label-by-path.sh && bash bin/rebuild.sh && bash bin/build-fts.sh`
- **ACCEPTANCE:** user confirmed the taxonomy; `bash verify-install.sh` reports a labeled-%
  PASS line (unmatched leftovers staying `-` is fine — extend the mapping later and re-run;
  it only fills unlabeled rows).

## Step 2 — load the doctrine

- **GOAL:** the agent knows WHEN to use the brain, not just how.
- **OUTPUTS:** add `DOCTRINE.md` to the agent's context wiring — e.g. an `@`-import from a
  CLAUDE.md, a sector file, or your harness's equivalent. Optionally generate the user's
  `MAP.md` from `templates/MAP-TEMPLATE.md` + the real room list.
- **ACCEPTANCE:** in a fresh session, asking "what do I know about <topic>?" triggers a brain
  query before any answer.

## Step 3 — optional wiring (each independent)

- **SessionStart digest** (Claude Code): `bash bin/register-digest-hook.sh` — backs up
  settings.json, idempotent. ACCEPTANCE: new session prints the 🧠 digest.
- **Nightly refresh** (macOS): write `~/Library/LaunchAgents/com.YOURNAME.newbrain.refresh.plist`
  running `bash <repo>/bin/refresh.sh nightly` on a daily schedule, then
  `launchctl load` it. ACCEPTANCE: next-day `moc/log.md` shows a `refresh (nightly)` line.
  (Only wire this AFTER Step 1 — refresh.sh calls the labeler.)
- **Discovery-hook rows** (if you use the companion claude-optimization system): merge
  `templates/TRIGGERS-example.tsv` rows into your TRIGGERS.tsv, fixing paths.
- **Keyword dictionary:** regenerate `bin/kw-dict.tsv` from YOUR corpus (frequency-derived
  tokens + their cross-language/synonym additions). The shipped file is the author's example.
  Note `expand.sh` stays un-wired — measured negative; the dictionary serves
  `abstain-check.sh`'s cold variant only.

## Uninstall — how to back out

Nothing here touches your notes. Data Brain never owned them; removing it removes an index.

```bash
rm -rf moc/                                                      # all generated data
git checkout bin/canon.sh                                        # restore the template roots
cp ~/.claude/settings.json.bak-graft3 ~/.claude/settings.json    # undo the SessionStart digest
launchctl unload ~/Library/LaunchAgents/com.YOURNAME.newbrain.refresh.plist && \
  rm ~/Library/LaunchAgents/com.YOURNAME.newbrain.refresh.plist  # undo the nightly refresh
```

Then remove the `DOCTRINE.md` import from your CLAUDE.md (or your agent's equivalent) and
delete this clone. The `.bak-graft3` file is the backup `bin/register-digest-hook.sh` writes
before it edits settings.json; skip that line if you never ran the hook. Skip the launchctl
lines if you never wired the nightly job.

## Done

- Final check: `bash verify-install.sh` — all PASS.
- Daily use: capture with `bin/capture.sh`, find with `bin/fts.sh` / `bin/look.sh`, refresh with
  `bash bin/refresh.sh manual` (or the nightly job). Health: `bin/lint.sh`.
