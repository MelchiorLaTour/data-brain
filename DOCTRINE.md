# DOCTRINE — how the agent uses the brain

This is the access doctrine: the behavioral rules an agent (Claude or any model that can run
bash) follows when querying the brain. It is the other half of the system — the engine in
`bin/` finds notes; this doctrine decides *when to search, how to phrase queries, when to
trust a hit, and when to honestly say "not in the brain."* Load it into the agent's context
(as a sector file, a CLAUDE.md import, or pasted doctrine) on any session that touches notes.

Data Brain is a search-and-map layer over notes that live elsewhere (no copies, ever):
an index (`moc/index.tsv`), pure bash + ripgrep + sqlite, zero model/API calls — works cold.

## What it is

- `moc/index.tsv` = label source of truth. Two rules that never bend: **no copies** and
  **never move/rename a Finder-visible file** (editing content is allowed, relocating is not).
- Read first: `MAP.md` at the brain root (hand-navigable, works with the agent off).

## Tools (`bin/`, bash, no equip)

- `look.sh "<keywords>" [k]` — PRIMARY read path (read-less-first). Runs `fts.sh` then prints a
  capped snippet of each top-k hit from the cheap extract tier, so you judge relevance WITHOUT
  opening whole notes. Read ladder: index scan → `look.sh` (ranked hits + cheap snippets) → open
  the full note only to quote/confirm. Default k=3; `LOOK_CAP=N` widens the snippet.
- `fts.sh "<keywords>" [limit]` — the search ENGINE under look.sh: BM25-ranked over
  title+themes+keywords+body. Doctrine: decompose the question into content keywords (named
  entities, the DISCRIMINATING concept nouns, both languages' variants of those if the corpus is
  bilingual), run 2–3 variants, read top-5; `⚠ WEAK MATCH` or no matches ⇒ answer "not in the
  brain". Rebuild after index.tsv changes: `build-fts.sh`.
  - **Cross-lingual queries (question in one language ↔ note in the other): YOU are the
    expander.** The index side is already bilingual, so add the OTHER language's word for the
    *key concept* as a query variant (e.g. a French workout question → also try
    `workout gym training`). This closes the multilingual gap — measured (author's corpus) as
    the only lever that moves it.
  - **Keep the keyword set TIGHT and DISCRIMINATING — never a broad synonym dump.** Measured
    (author's corpus): mechanically expanding a query with generic synonyms drowns the real note
    under its siblings and floats off-topic profile docs to the top, and bled hits@1 everywhere.
    Fewer, on-topic, discriminating words beat many loose ones. Say less.
- `abstain-check.sh "v1" "v2" [v3]` — the "is it even in here?" ritual, in one command. Runs your
  2–3 variants through `fts.sh` and prints a routing hint (CONVERGENT / MIXED / DIVERGENT+WEAK / DRY).
  The hint is NOT a verdict — it is a reading order. It is confidently wrong sometimes (agrees on a
  keyword decoy), so the READ is load-bearing: always `look.sh` the top hits, judge whether they
  actually answer, THEN answer or abstain. Measured (author's corpus): route→read→judge = 10/10
  honest trap-abstain, 0 false-abstain. Pass one query to get a cold bilingual dictionary variant
  for free.
- `search.sh "<phrase>"` — exact-phrase full-text fallback (regex over note bodies)
- `capture.sh` — drop an idea/note into the inbox
- `inbox-status.sh` — unrouted count
- `recent.sh` — recent captures
- `index-add.sh` — register an existing note in the index
- `synth-save.sh "Title" "themes"` (body on stdin) — wire an agent SYNTHESIS back in as a new note
- `lint.sh` — ledger health (dead paths, unlabeled; dup-title noise is by-design)
- `reach-map.sh` — link/reach analysis
- `compile-room.sh` — room compilation (see "Room wikis" below)

## Routing (when to reach for it)

- A SessionStart digest (`bin/brain-digest.sh`, a hook) primes every session with the room map + the
  access line, so the gate — "is this an owner-knowledge question? → brain FIRST" — is already in context.
- The owner's knowledge, notes, people, ideas → brain FIRST, before answering. Past agent-session
  work → your session-memory tool. Query via `fts.sh` (decomposed keywords); `search.sh` only for
  exact phrases. Judgment ritual (when "do I even have this?" is the question): `abstain-check.sh`
  your 2–3 variants → `look.sh` the hits it routes you to → answer if a note actually answers, else
  say "not in the brain". The abstain is YOUR call after reading, never the tool's hint word.
- Find-a-file: brain index first, `mdfind` (Spotlight) fallback for unindexed files, filesystem
  crawl last. Skip all of it when the owner names the location explicitly.
- **Synthesis write-back (the brain compounds).** When you produce a real SYNTHESIS in a brain
  context (you read notes + reasoned into a new conclusion the owner would want to keep), do NOT let
  it evaporate: show it, then ask ONE inline **"wire this into the brain? [keep/drop]"**. On *keep*,
  run `bin/synth-save.sh "Title" "themes" <<'EOF' … EOF` (it writes the note to the syntheses home,
  indexes it, rebuilds). On *drop*, do nothing. Never wire one in without the yes — a wrong
  synthesis poisons future retrievals. Raw/ambiguous captures still go to `capture.sh`/INBOX, not
  here; this is for derived conclusions only.
- **Synthesis-over-a-cluster (a vague aggregate ask is NOT a rank-1 failure).** When the question is
  aggregate / longitudinal / comparative over the owner's OWN notes — "how have my X changed /
  evolved", "what were all my Y", "the through-line across my Z over the years" — and the search
  returns a CLUSTER of near-tied siblings (many hits of the same kind, no dominant top hit) instead
  of one clear note, do NOT try to float a single note to rank 1. Measured (author's corpus): no
  keyword set can, and it shouldn't have to — that shape is a SYNTHESIS question wearing a search
  query's clothes. Instead read the cluster and reason across it:
  `LOOK_CAP=6000 look.sh "<tight discriminating keywords>" 10` pulls the whole sibling set's bodies
  from the cheap extract tier in one call (raise k/CAP as the cluster is bigger); read the N
  siblings, then SYNTHESIZE the trend / through-line — the brain's ONE legitimate synthesis job
  (retrieval feeds it; brain = RETRIEVAL, synthesis needs the agent). Then offer the synth-save
  above — a longitudinal synthesis is exactly the derived conclusion worth compounding. Recognizing
  the cluster is YOUR judgment (aggregate query shape + near-tied hits); there is no mechanical
  detector on purpose — measured that score-band thresholds don't separate cleanly, so the call
  stays behavioral, like abstain-check's hint.
- Fat nodes split on contact, not preemptively: over ~2k tokens AND part-used → split along
  natural seams into 2–5 children (seams decide the count, never invent one); children inherit
  the rule; deeper than two levels is rare by design.
- **Room wikis = an ON-DEMAND synthesis cache (never pre-compile every room).** A room wiki
  (`moc/wiki/<room>/OVERVIEW.md` + concept pages) is compiled synthesis over that room's notes —
  measured (author's corpus) to answer aggregate/curated questions more accurately AND with ~43%
  fewer tool calls than raw search, and to correct raw-search errors (the LLM-wiki pattern). But it
  is a CACHE: compile a room ONLY when synthesis questions about it recur — the always-on search
  path already covers all rooms, so wholesale pre-compilation is wasted work that rots.
  - **Refresh-on-demand** (triggered by "refresh/recompile the <room> wiki", or a stale flag):
    `bash bin/compile-room.sh <room>` gathers the room into `_BUNDLE.md` (pure bash, no copy, writes
    a freshness stamp) → then YOU read the bundle and rewrite OVERVIEW + concept pages cluster-wise
    (define clusters from titles/paths cheaply, sample bodies, write at cluster grain; small rooms
    <~100 notes one-shot, a multi-MB room must be per-cluster). Recompiling restamps → clears
    the flag.
  - **Anti-rot (a wiki can NEVER silently rot).** `compile-room.sh` stamps each `_BUNDLE.md` with the
    room's note-count + content hash at build time; `bin/stale-wikis.sh` recomputes it, and both
    `lint.sh` and the SessionStart digest print `⚠ wiki stale: <room> (N→M notes)` the moment a
    room's notes drift — so rot auto-surfaces every session (no remembered ritual). See it, recompile.
