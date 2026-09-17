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

Prerequisites: bash, `rg` (ripgrep), `sqlite3` (install.sh checks and tells you what's missing).

---

## Step 0 — run the installer  [no LLM needed]

```
./install.sh
```

It checks dependencies, walks you through picking your canonical roots (the directory trees
holding your notes), writes them into `bin/canon.sh`, builds `moc/index.tsv`, optionally runs
the binary-extract pass, builds the ranked-search index (`moc/fts.db`), and smoke-tests a query.

Every row is left deliberately **unlabeled ('-')**: the labeler only ever fills unlabeled rows,
so labels must not be stamped until YOUR mapping exists (that's Step 1). Junk-folder prunes can
be extended anytime via the `EDIT:` blocks in `bin/canon.sh`.

- **ACCEPTANCE:** install.sh prints "smoke test: OK"; `bash verify-install.sh` shows only the
  0%-labeled WARN as its non-PASS line.

## Step 1 — propose and write the room mapping  (the one real agent step)

- **GOAL:** replace the EXAMPLE mapping in `bin/label-by-path.sh` with the user's folder→room
  rules, then label the index.
- **DISCOVER:** the distinct parent-directory patterns in `moc/index.tsv` column 1
  (`cut -f1 moc/index.tsv | sed "s#$HOME##" | cut -d/ -f2-3 | sort | uniq -c | sort -rn`).
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

## Done

- Final check: `bash verify-install.sh` — all PASS.
- Daily use: capture with `bin/capture.sh`, find with `bin/fts.sh` / `bin/look.sh`, refresh with
  `bash bin/refresh.sh manual` (or the nightly job). Health: `bin/lint.sh`.
