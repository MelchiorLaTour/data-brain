# How it works

Data Brain solves one problem: an AI agent that answers questions about *your* notes without
ever looking at them. The fix has two halves — a mechanical half (an index the agent can
search in milliseconds, with the agent completely off) and a behavioral half (a doctrine
that tells the agent when to search, how to phrase queries, and when to honestly say "not
in the brain"). This page walks both, bottom-up.

## The index — one TSV, one sqlite file, some sidecars

The whole state of the system is:

```
moc/index.tsv      the label source of truth
moc/fts.db         rebuildable sqlite FTS5 database
moc/extracted/     plaintext sidecars for binary files
moc/rooms/         derived room maps (rebuildable)
moc/log.md         append-only borrow/refresh ledger
```

### index.tsv anatomy

One row per note, four tab-separated columns:

```
path · title · themes · keywords
```

- **path** — the note's real, canonical location. Never a copy. Delete `moc/` entirely and
  your notes are untouched — the brain is an *access layer*, not a store.
- **title** — filename-derived, cleaned.
- **themes** — the note's room(s), e.g. `cooking` or `school career`. A `-` means
  unlabeled. Labels live *here*, in the TSV — never in your folder structure. Organizing a
  note = editing a TSV field, not dragging a file.
- **keywords** — searchable terms beyond the title (backfilled, optionally bilingual).

`ingest-root.sh` walks your canonical roots (defined in `bin/canon.sh`) and appends rows
for files it hasn't seen; it never modifies existing rows. `canon.sh` also carries the
prune lists — junk dirs (node_modules, caches, build output) and a `Resources/Sensitive`
path so credentials never enter the index.

### fts.db

`build-fts.sh` loads the index rows — title, themes, keywords, plus each note's body text
(or its extract, for binaries) — into a sqlite FTS5 table. That gives `fts.sh` BM25-ranked
full-text search over ~thousands of notes in well under a second, pure sqlite, no model, no
network. The database is a derived artifact: corrupt it, delete it, rebuild it. The TSV is
the truth.

### extracts

Search is only as good as what's searchable. PDFs, docx files, and cloud-offloaded
placeholders have no greppable body — `extract.sh` converts each to a plaintext sidecar in
`moc/extracted/` (800KB body cap, so a textbook stays title-only instead of drowning the
index). The extract tier is also what makes reading cheap: `look.sh` prints snippets from
extracts instead of opening whole originals.

## The search ladder — read-less-first

The agent's cost is context tokens; the design keeps them low by escalating in tiers:

```bash
# 1. Ranked hits — titles + scores only, cheap
bin/fts.sh "sourdough starter hydration" 5

# 2. Snippets — capped extract slices of the top hits, still cheap
bin/look.sh "sourdough starter hydration" 3

# 3. Open the full note — ONLY to quote or confirm
```

The agent scans ranked hits, reads snippets, and opens a full note only when it's about to
cite it. For "do I even have this?" questions there's a fourth tool:

```bash
bin/abstain-check.sh "sourdough hydration" "starter feeding ratio"
```

It runs 2–3 query variants and prints a routing hint — CONVERGENT (variants agree, read
the top hit), MIXED, DIVERGENT+WEAK, or DRY. The hint is a *reading order*, not a verdict:
the agent still reads before judging. That route→read→judge ritual is what produced the
10/10 honest-abstention result on trap questions (author's corpus, N=1) — `⚠ WEAK MATCH`
output is the mechanical basis for answering "that's not in the brain" instead of
hallucinating recall.

## Labeling and the misc-trap

`label-by-path.sh` turns folder patterns into room labels — but it **only fills rows whose
themes are `-`**. It never relabels. That's a safety property (your hand-corrections are
never overwritten) with a sharp edge: if anything stamps a *default* label before your real
folder→room mapping exists, every row gets that default and your real mapping can never
take effect.

This is why `install.sh` deliberately leaves every row unlabeled, why the shipped template
mapping defaults to `return "-"` (leave unlabeled) rather than any catch-all room, and why
the nightly refresh job must only be wired *after* the labeling step: `refresh.sh` calls
the labeler.

## The doctrine — the behavioral half

Everything above works with the agent off. What the agent adds is judgment, and
`DOCTRINE.md` is where the judgment rules live:

- **Decompose, don't paste.** Turn the question into 2–3 tight, discriminating keyword
  variants — named entities and concept nouns, not synonym dumps (measured: mechanical
  synonym expansion *hurt* ranking; the tool that did it ships disconnected as a negative
  result).
- **You are the cross-lingual expander.** For a bilingual corpus, the agent adds the other
  language's word for the key concept as a variant — measured as the only lever that closed
  the cross-lingual gap.
- **Cluster questions are synthesis questions.** "How have my X changed over the years?"
  returns near-tied siblings, not one winner. The doctrine says: pull the cluster's bodies
  in one `look.sh` call, read, synthesize — then offer to wire the synthesis back in as a
  new note (`synth-save.sh`), so the brain compounds.
- **Room wikis are an on-demand cache.** `compile-room.sh` bundles a room for the agent to
  rewrite as a curated wiki — measured to beat raw search on aggregate questions with ~43%
  fewer tool calls. But wikis rot, so every bundle carries a note-count + content-hash
  stamp, and `stale-wikis.sh` + the session digest surface drift automatically. Compile
  only rooms whose synthesis questions recur.

## Why this shape

Every design decision falls out of two contracts: **no copies** (notes live once, in their
real homes) and **never move or rename a Finder-visible file** (labels live in the TSV).
Given those, the index must be a pointer layer; given a pointer layer, search must be
rebuildable from disk; given an agent whose failure mode is confident fabrication, the
doctrine must make abstention a first-class answer. The engine stays pure bash so all of it
holds with the model out of the loop.
