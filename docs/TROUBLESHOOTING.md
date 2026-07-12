# Troubleshooting

Findings from sandbox-testing the installer on a clean fake `$HOME` (macOS, stock bash 3.2 +
BSD awk), plus the interpretation guide for `verify-install.sh`.

## install.sh

**"path contains spaces — hand-edit bin/canon.sh instead"** — the installer refuses roots
with spaces in the path by design (the awk rewrite of the CANON block would need fragile
quoting). Not a dead end: open `bin/canon.sh`, find the `CANON=(` block, and add your root
as a quoted line, e.g. `"$HOME/My Notes"`. Everything downstream handles spaces fine —
only the automated rewrite step doesn't.

**Missing dependencies** — `rg` (ripgrep) and `sqlite3` are hard requirements; install.sh
stops and prints the `brew install` / package hints. The extract converters (`pdftotext`,
`textutil`/`pandoc`) are optional: missing ones just mean those file types stay title-only
in the index. Install them later and re-run `bash bin/extract.sh` — it's resumable and
idempotent.

**Apostrophes and other special characters in paths** are handled (the root list is passed
to awk via the environment, not command-line `-v`, precisely to survive them). Tested with
an apostrophe path on BSD awk and gawk.

**Stray "off" line during the FTS build** — cosmetic sqlite echo, not an error. Ignore it.

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
