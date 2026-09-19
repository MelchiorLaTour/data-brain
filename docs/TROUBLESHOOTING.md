# Troubleshooting

Findings from sandbox-testing the installer on a clean fake `$HOME` (macOS, stock bash 3.2 +
BSD awk), plus the interpretation guide for `verify-install.sh`.

## Before you start

Run `bash verify-install.sh --preflight "<root>"`. It is read-only, takes seconds, and catches
most of what follows before it can waste an install.

**"sqlite3 lacks FTS5"** — FTS5 is a compile-time option, so a sqlite3 without it passes a
plain `command -v` check, installs and runs normally, then fails at `build-fts.sh` with no
ranked search. macOS: `brew install sqlite`, then put it ahead of `/usr/bin` on `PATH`.

## install.sh

**Paths with spaces** — supported. Quote the path on the command line
(`./install.sh --obsidian "$HOME/My Vault"`), or in the picker choose the "other" option, which
reads **one path per line** (it still accepts several space-separated paths on one line, so the
old habit works too). The `CANON` block is written one quoted line per root, so spaces,
apostrophes and regex-special characters all survive.

**"no roots given and stdin is not a terminal"** — the picker needs a terminal, and an agent
running `./install.sh` without one used to hit `read`, get EOF, and exit with the misleading
"nothing picked". Pass the roots instead: `./install.sh --roots "$HOME/Notes"` or
`./install.sh --obsidian "$HOME/Vault"`. Full list: `./install.sh --help`.

**An interrupted run** — just re-run it. Ingest is append-only and dedup'd, extract and the FTS
build are idempotent, and `INSTALL-STATE.md` records each completed stage under a
`--- run <timestamp> ---` header, so you can see exactly where it stopped.

**Missing dependencies** — `rg` (ripgrep) and `sqlite3` are hard requirements; install.sh
stops and prints the `brew install` / package hints. The extract converters (`pdftotext`,
`textutil`/`pandoc`) are optional: missing ones just mean those file types stay title-only
in the index. Install them later and re-run `bash bin/extract.sh` — it's resumable and
idempotent.

**Apostrophes and other special characters in paths** are handled (the root list is passed
to awk via the environment, not command-line `-v`, precisely to survive them). Tested with
an apostrophe path on BSD awk and gawk.

**Stray "off" / "delete" line during the FTS build** — cosmetic sqlite echo, not an error.
Ignore it.

**"smoke test: SKIPPED — no usable word derived from titles"** — rare, and not a failure: none
of the first 200 indexed titles held a token of 4+ characters. Run one yourself:
`bash bin/fts.sh <a topic you know you have> 3`.

**Extract prints nothing for a long time** — it now prints `...N files done` every 25 files.
If you see no such line at all, it found no candidates (no PDFs/DOCX, or all already
extracted); the end summary confirms which.

**Extract pass seems slow** — it's linear in corpus size and the prompt warns about this.
Safe to decline at install time and run `bash bin/extract.sh` later (or in batches); it
picks up where it left off.

## verify-install.sh — reading the output

A fresh, correct install prints **8 PASS / 0 FAIL / 1 WARN**. The one expected WARN:

- **"0% labeled"** — correct and deliberate after install.sh alone. Labeling is INSTALL.md
  Step 1 (the agent step), because the labeler only fills unlabeled rows and must not run
  before YOUR folder→room mapping exists (see the misc-trap section in
  [HOW-IT-WORKS.md](HOW-IT-WORKS.md)). After Step 1 this becomes a PASS.

Any FAIL line names the broken piece directly (missing dep, empty CANON, missing index,
empty FTS table, dead smoke query). Fix that piece and re-run — the script is read-only
and safe to run as often as you like.

## Search

**Smoke test / fts.sh returns no hits right after install** — three usual causes, in
order: (1) the FTS build didn't run after the last index change — `bash bin/build-fts.sh`;
(2) your roots hold mostly binaries and you skipped the extract pass, so bodies are empty —
run `bash bin/extract.sh` then rebuild FTS; (3) the query words genuinely aren't in the
corpus — try a title word you can see in `moc/index.tsv`.

**`⚠ WEAK MATCH` on a query that should hit** — usually a phrasing gap, not an index gap.
Try 2–3 tighter keyword variants (see DOCTRINE.md on decomposition) before concluding the
note is missing.

## Labeling

**Rows still `-` after running the labeler** — the mapping in `bin/label-by-path.sh`
didn't match those paths. That's the designed behavior (unmatched rows stay unlabeled
rather than getting a junk default). Extend the `room()` mapping and re-run — it only
touches `-` rows, so it's always safe.

**A row got the wrong room** — edit the themes field in `moc/index.tsv` directly, then
`bash bin/rebuild.sh && bash bin/build-fts.sh`. The labeler will never overwrite your
hand-fix.

## Nightly refresh

**Wired the launchd job and labels went wrong** — the refresh pipeline calls the labeler,
which is why INSTALL.md says wire it only *after* Step 1. If you jumped early with the
template mapping in place: nothing is destroyed (the template default leaves rows
unlabeled); write your real mapping and run `bash bin/label-by-path.sh` — it fills the
still-unlabeled rows.

**Refresh doesn't fire** — check `launchctl list | grep newbrain`, and that the plist's
program path points at your actual clone. On Linux/WSL use cron instead (see
[COMPATIBILITY.md](COMPATIBILITY.md)).
