# Migration guide — from no brain or Obsidian to NewBrain

This document is written for an AI agent executing the migration. The agent must preserve
the user's original files, avoid destructive actions until verification succeeds, and report
each acceptance check as PASS or BLOCKED. A strong planning model should create the plan from
the inventory; smaller execution models should perform the deterministic shell steps and
record evidence. No model should silently invent labels, links, or test answers.

## What NewBrain is

NewBrain is a local, no-copy access layer over ordinary files. The user's Markdown, PDF,
DOCX, and other note files remain in their existing folders. NewBrain creates a rebuildable
index and SQLite FTS5 search database under `moc/`; it does not become the canonical owner of
the notes. The engine makes no network calls and does not require a model to search.

The safe mental model is:

```text
canonical note files -> NewBrain index -> ranked search -> agent reads the original file
```

The index can be deleted and rebuilt. The canonical notes are the valuable data.

## Route A — starting with no current brain

Use this route when the user has files but no existing second-brain index.

### Preconditions

1. Identify the directories that contain the user's canonical notes.
2. Do not include credential or secrets directories. Keep sensitive material outside the
   configured roots and outside the index.
3. Confirm that the user has a backup of irreplaceable files before any bulk operation.

### Procedure

1. Clone or copy this repository to a local working directory.
2. Run `./install.sh`.
3. Select the canonical note roots when prompted. Do not select the whole home directory
   unless the user intentionally wants that scope.
4. Let the installer build `moc/index.tsv`, optional text extracts, and `moc/fts.db`.
5. Run `bash verify-install.sh`.
6. Inspect the index and propose a room taxonomy from the real folder patterns. Do not write
   labels until the user confirms the proposal.
7. Edit the `EDIT:` mapping in `bin/label-by-path.sh`, then run:

   ```bash
   bash bin/label-by-path.sh
   bash bin/rebuild.sh
   bash bin/build-fts.sh
   ```

8. Add `DOCTRINE.md` to the user's agent context. For Claude Code, use the project's
   context-import mechanism; for another agent, load the file as system/project guidance.
9. Run `bash verify-install.sh` again and run a known-note smoke query with `bash bin/fts.sh`.
10. Only after all checks pass, optionally register the SessionStart digest or a scheduled
    refresh. These are convenience features, not prerequisites.

### Acceptance criteria

- `verify-install.sh` passes its dependency, index, FTS, and smoke-test checks.
- At least one known note is returned by `bin/fts.sh`.
- The agent searches before answering questions about the user's notes.
- The agent says `not in the brain` when the result is weak or absent instead of guessing.

## Full setup, relationship pass, and recall gate

Installation is not complete when `moc/fts.db` exists. The agent must run the following
phases in order. The planning model may adjust the order after inspecting the inventory, but
the acceptance gates and the four recall strata must not be skipped.

### Phase 1 — inventory (planner model)

1. Enumerate every selected root and count files by extension and directory.
2. Exclude secrets, caches, generated indexes, and unsupported application state.
3. Produce a short plan naming the roots, expected file count, proposed rooms, and any
   formats that need extraction.
4. Ask the user only about unresolved ownership or taxonomy decisions. Do not ask a model to
   guess what a personal folder means.

### Phase 2 — deterministic ingestion (executor models)

1. Run `install.sh` or `refresh.sh` to ingest every approved root.
2. Run extraction for supported PDF/DOCX/offloaded files.
3. Label, rebuild rooms, and rebuild FTS5.
4. Run `verify-install.sh` and save its output as the phase evidence.
5. If the indexed count differs from the inventory, stop and report the missing paths; do not
   continue by silently lowering the scope.

### Phase 3 — relationship/linking pass (executor models)

NewBrain's safe relationship layer is deterministic metadata, not an opaque semantic graph.
For each indexed file, preserve its canonical path, room, title, keywords, explicit Markdown
links, and duplicate/conflict status. Build relationships only from evidence such as an
explicit link, the same canonical path family, a confirmed duplicate, or a shared user-approved
room. Shared keywords alone are not proof that two files contain the same information.

The planner model reviews a relationship report; executor models run the scripts and validate
counts. Conflicts are reported for human review. No relationship pass may rewrite or merge
canonical notes.

### Phase 4 — recall acceptance exam (judge model)

Create a private query fixture with the same four strata every time. Start from
[`templates/RECALL-TESTS.tsv`](../templates/RECALL-TESTS.tsv), then keep the populated fixture
outside the public repository because it contains personal paths and answers.

| Stratum | Required contents |
|---|---|
| Easy | direct wording whose answer file is known |
| Medium | paraphrased wording with several answer-bearing files |
| Hard | indirect wording, distractors, and competing notes |
| XLING | equivalent questions and answers across languages |

Each query row must contain an ID, stratum, question, expected answer path(s), and a trap flag
when the answer is intentionally absent. The fixture must be held out from tuning. Score
answer-bearing recall at rank 3 separately for Easy, Medium, Hard, and XLING; score trap
honesty separately. Never replace these rows with one blended percentage.

The recommended acceptance bars are Easy 100%, Medium 100%, Hard at least 32/40 (80%), and
XLING at least 16/20 (80%), plus honest abstention on every valid trap. If a project uses
different denominators, record them before running the exam and keep them unchanged between
versions.

The judge model labels whether a returned path is answer-bearing. Lower-cost executor models
may run queries, collect ranked paths, and calculate scores, but they must not change labels or
quietly drop failures. A failed gate returns to diagnosis; it does not become a PASS because
the total file count looks correct.

### Efficient model allocation

1. Use one high-capability planning model for inventory interpretation, taxonomy proposals,
   test-fixture design, and final audit.
2. Use lower-cost models or shell workers for repetitive ingestion, extraction, relationship
   counting, query execution, and report assembly.
3. Use a separate judge model for recall labels so the planner is not grading its own guesses.
4. Cache inventory and extraction results. Re-run only changed roots or failed phases.
5. Stop early when a gate fails for a structural reason (missing root, unreadable file, absent
   expected path); repair the cause before spending time on more queries.

### Time expectations

These are planning estimates, not performance guarantees. A new installation commonly needs
roughly a couple of hours because it includes inventory, taxonomy decisions, extraction,
relationship review, and the first recall exam. An Obsidian migration can often fit in roughly
30 minutes when the vault is already clean and the backup, root selection, and representative
query set are ready. The agent must report measured wall time after each phase rather than
claiming the estimate was achieved.

## Route B — migrating from Obsidian

Obsidian is not required by NewBrain. Obsidian stores a vault of files and adds a graphical
editing/linking layer; NewBrain uses the files directly and adds deterministic indexing,
ranked retrieval, refresh, and an agent doctrine. The migration is therefore a change of
access layer, not a conversion into a proprietary database.

### Preserve first

1. Close Obsidian so it is not changing files during the migration.
2. Make a complete backup of the Obsidian vault, including hidden files such as `.obsidian/`.
3. Keep the backup until the user has completed several successful NewBrain searches and
   explicitly approves disposal of Obsidian data.
4. Treat Markdown files as canonical. Do not delete `.md` files, attachments, or the vault
   backup during installation.

### Install NewBrain over the vault

1. Configure the Obsidian vault directory as a canonical root in `bin/canon.sh` through
   `./install.sh`.
2. Decide whether attachments should be indexed. Keep binary attachments in place; NewBrain
   may create derived text sidecars for supported formats.
3. Run the Route A procedure from Step 4 onward: build, verify, propose labels, label, rebuild,
   load the doctrine, and run known-note searches.
4. Test representative notes from every important vault area, including a note with links,
   a note with tags, and a note containing an attachment reference.
5. If Obsidian wikilinks or graph navigation are still needed, keep Obsidian installed while
   evaluating NewBrain. NewBrain does not depend on Obsidian and does not reproduce every GUI
   feature.

### Safe Obsidian retirement

Deleting Obsidian is optional, not a technical requirement. Retire it only when all of the
following are true:

1. The vault backup exists and can be opened or restored.
2. NewBrain's `verify-install.sh` passes.
3. Representative searches return the expected original files.
4. The user has decided that Obsidian's editor, graph, plugins, and wikilink UI are no longer
   needed.
5. The user explicitly approves deleting the Obsidian application and/or the local vault.

If approved, remove the Obsidian application separately from the vault. Do not delete the
vault merely because NewBrain was installed. If the vault itself is retired, archive it or
move it to a user-approved backup location first, then verify that the canonical files now
used by NewBrain are intact. Never use a wildcard delete against the user's home directory.

### Why a user may retire Obsidian

- NewBrain can search the existing files without a second proprietary workspace.
- The engine is model-free, local, and rebuildable.
- The agent receives one deterministic search-and-abstain path instead of relying on a GUI
  being open.
- Removing an unused application reduces duplicated indexing and maintenance.

These are operational reasons, not a claim that Obsidian is universally inferior. If the
user still values Obsidian's editing or graph features, keep it and use NewBrain alongside it.

## Non-negotiable migration rules for agents

- Never move, rename, overwrite, or delete canonical notes during installation.
- Never read or index secrets directories.
- Never claim migration success without a fresh `verify-install.sh` result and a known-note
  search.
- Never delete Obsidian or its vault without explicit user approval after backup verification.
- Report the exact roots indexed, the verification result, and any remaining weak matches.
