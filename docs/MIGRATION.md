# Migration guide — from no brain or Obsidian to NewBrain

This document is written for an AI agent executing the migration. The agent must preserve
the user's original files, avoid destructive actions until verification succeeds, and report
each acceptance check as PASS or BLOCKED.

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
