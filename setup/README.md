# DataBrain app setup work

This directory tracks the Claude Desktop extension work. It is separate from the
terminal installation path in the repository root. The engine remains shared; generated
brains, indexes, and user documents never belong here.

## Current state

- Product engine: this repository, at the commit recorded in `ACCEPTANCE.md`.
- Claude Desktop prototype: a separate, pre-existing worktree with uncommitted user edits;
  preserve it while adapting reusable behavior.
- First-party MCP server source now exists in `setup/mcp/`: onboarding tools, selected-root
  grants, shared-engine indexing, ranked search, an evidence-reading abstention route,
  and capped reads.
- The packaged MCPB uses Claude Desktop extension settings to pass the destination parent
  and one or more source roots to the server. Setup creates `<parent>/DataBrain` only after
  explicit chat confirmation and records selected roots without reading them. Settings
  changes require restarting the extension; the read-only install audit reports drift. The
  next source operation revokes removed roots and prunes their generated search data, but
  newly selected roots still require the explicit add or replace action before they are
  granted.
  Disposable tests cover this handoff, but the actual Claude Desktop settings UI has not
  been tested in a physical install.
- `bin/extract.sh` uses the system `pdftotext` when present and falls back to
  `setup/mcp/pdf-extract.js`, which extracts searchable text through macOS PDFKit.
  The synthetic PDF test passes with Homebrew binaries removed from `PATH`; scanned-image
  PDFs still need OCR. For approved local Markdown/text files missing keywords, the engine
  safely reads through a verified descriptor, stores top content terms in the generated index,
  and does not create duplicate body sidecars or modify originals. `moc/extract-report.tsv`
  records extraction success, title-only, cached, missing, failed, and keyword-selection
  outcomes; MCP status reports missing/failed names and the refresh
  action rather than silently calling those items complete. Extracted text sidecars carry a
  source path and inode-aware metadata fingerprint; retries replace partial sidecars atomically,
  preserve the previous extract on failure, and refresh re-extracts when source metadata changes.
  Extraction copies bytes through a verified open descriptor and rejects source swaps before
  and after open. The MCP read route rejects symlinked,
  mismatched, or stale sidecars before returning their text.
- Folder-based category proposals and explicit application to unlabeled generated index
  rows are available; proposals use indexed titles and extracted keywords without reading
  document bodies. `moc/inventory.tsv` reconciles eligible supported files with indexed
  records and separately reports unsupported, unreadable, cloud-placeholder, empty, and
  traversal-error counts. Missing/failed extraction rows are surfaced through MCP status
  with a refresh action. `databrain_add_sources` preserves existing approvals while adding
  folders; replacing the selection revokes omitted roots and prunes their generated rows,
  text sidecars, and relationship report.
  `databrain_health` checks that indexed paths remain inside approved roots, reconciles
  the generated inventory, runs SQLite's read-only integrity check, and reports added,
  deleted, changed, or untracked source files from metadata only. It does not claim
  retrieval readiness or read document bodies; setup-status polling does not rescan roots.
  `databrain_verify_install` is the guided post-setup audit: a successful call confirms the
  DataBrain MCP process serving this conversation and reports its bundle root, version, and
  engine revision; it compares the running bundle and its
  settings-provided destination/source roots with saved setup, and checks the bundle against
  the version-matched public GitHub release's `databrain.buildinfo.txt`, including prereleases,
  confirms the published MCPB/checksum assets, source commit, and version-tag target, then checks
  inventory/index/freshness and confirmed setup metadata, runs one indexed search/read smoke
  probe and an absent-query probe, and returns evidence/status (the short read probe is
  discarded locally). The GitHub request is read-only and sends no corpus data; it reports
  BLOCKED when offline or before a release record exists. Claude's initialization
  instructions direct it to run this audit after relationship setup. It does not certify
  held-out answer quality. It reports original MCPB archive provenance as BLOCKED because the
  unpacked process cannot prove the downloaded ZIP checksum or install source. It checks the
  settings values passed to the running server against
  saved destination/source grants, but separately reports Desktop install-record/restart
  verification as BLOCKED because the MCP cannot inspect the hidden extension-manager record or verify restart/fresh-chat
  behavior. The physical Desktop path remains an acceptance gate.
  After the user asks to save new content, `databrain_capture`, `databrain_file_note`,
  and `databrain_save_synthesis` each open a destination chooser scoped to an approved
  source folder. They create a new Markdown file without replacing an existing file,
  store selected search keywords in the shared index, and rebuild ranked search. The
  package fixture covers all three routes; the chooser remains unverified in Claude Desktop.
  Terminal `bin/capture.sh` likewise writes only to an approved folder, records 2–12
  selected keywords, and verifies search/inventory entry without writing to the checkout.
  Disposable engine/MCP fixtures pass, including parent-folder containment with canonical
  filesystem paths and a parent-symlink swap during root enumeration. The shared walker rejects
  the changed root without altering the existing index. A partial `find` result followed by an
  error also leaves the previously seeded index intact. `test_extract_races.sh` rejects source
  swaps before and after descriptor open, preserves the previous extract, and confirms outside
  bytes do not enter generated state; MCP tests also reject raced reads and relationship hashing.
  `test_mcp_desktop_settings.mjs` verifies settings-based folder recording, add/revoke behavior,
  and audit drift; `test_mcp_onboarding.mjs` checks destination consent and existing-folder refusal
  with a test-only chooser. No source is read before setup consent. These are local fixtures; the
  actual Claude Desktop settings UI remains unverified. A deterministic relationship report records local Markdown links, exact-byte
  duplicate groups, same-title review flags, and unavailable source rows without editing
  originals or inferring semantic links. Local lifecycle fixtures cancel an interrupted
  indexing child process, restart the
  MCP server, and resume from the persisted stage; a cancelled relationship scan does not
  publish a partial report. A same-version package-replacement/uninstall simulation also
  proves saved DataBrain/search state and source bytes survive a process restart and removal
  of only the disposable extension directory; it does not simulate Claude Desktop update or
  uninstall behavior. Repeating setup is checked for saved-state and original-file
  preservation. The app and Terminal share deterministic relationship and
  taxonomy proposal/application cores; selected-root tests compare complete relationship
  reports, exact metadata-only proposal text, and resulting index semantics. The skewed
  50-file package fixture also verifies the post-setup audit across ten uneven categories.
  `test_mcp_multivariant_workflow.mjs` also checks packaged multi-query search, safe read,
  all-absent DRY guidance, and a plausible decoy read-first route; it does not validate
  Claude's query generation, answer judgment, or citations.
  The single-query diagnostic scores Easy 10/10, Medium 8/10, Hard 23/40, and XLING 2/20,
  below three unchanged bars. The acceptance route uses 80 frozen query-only variants and
  scores the union of per-query top-three results: Easy 10/10, Medium 10/10, Hard 40/40,
  and XLING 16/20, meeting the original bars. Ten all-absent variants stayed DRY; ten
  plausible traps surfaced candidates on a read-first route. These synthetic checks do not
  prove Claude-generated query quality, held-out recall, answer correctness, citations, or
  model judgment. Those retrieval-readiness checks remain open. Maintained HTML sources exist for the app guide, Terminal guide,
  and pre-connection recovery card. The app source now points to the verified v0.1.0 prerelease;
  an explicitly unverified one-page guide review is saved under `/private/tmp/databrain-review/`.
  Final accepted-product guides remain blocked on physical Claude Desktop acceptance. See
  `PARITY.md` and `ACCEPTANCE.md`.
- The dirty prototype remains untouched and is not a substitute; it requires a prebuilt
  brain folder. Physical Claude Desktop acceptance remains separate from local tests.

## Maintainer sequence

1. Keep the capability and permission contract in `PARITY.md` current as implementation
   decisions are made.
2. Implement against the existing `bin/` engine. Do not create a second index/search
   implementation.
3. Record each command, fixture, result, and artifact path in `ACCEPTANCE.md`.
4. The reviewed `setup/mcp/manifest.json` and reproducible builder are present. Run
   `bash setup/packaging/build.sh`; inspect the archive and verify its `.sha256` checksum.
   Attach `databrain.mcpb`, `databrain.mcpb.sha256`, and the generated
   `databrain.buildinfo.txt` as release assets so installed copies can compare their build identity with the published release.
   The public v0.1.0 prerelease is unverified; do not replace its tag or assets. Publish corrections under a new package version.
5. Keep app-route and terminal-route guides separate and retain the pre-connection recovery
   source. Do not move final release PDFs to Downloads until Desktop settings and package
   behavior have physical acceptance evidence.
6. Do not push or publish until Mel approves the reviewed handoff.

## Shared engine state boundary

The app adapter passes `NB_MOC_DIR` to the existing terminal scripts so `index.tsv`,
extracted text, room maps, and the FTS database live under the user's approved DataBrain
folder while the executable engine stays in the extension. `NB_CANON_ROOTS_FILE` points
the same scripts at a newline-delimited list of user-selected roots. If that grant file is
missing, empty, or references unavailable folders, the engine fails closed instead of
falling back to terminal defaults. Unset variables preserve the terminal behavior.
`setup/tests/test_moc_override.sh` exercises both selected roots, a DOCX, search, refresh,
failed-index replacement, and original-file hashes using disposable fixtures.
It also proves content-derived DOCX/PDF keywords remain searchable with body sidecars
removed, exercises PDFKit without Homebrew tools, runs MCP search/capped-read through the
same engine index, denies an unapproved
path, proposes categories from indexed titles/keywords without bodies, applies a confirmed
folder category into the shared index, and verifies source selection prunes revoked rows and
generated extracts, rejects a symlinked generated index, and prunes a permission-denied
`Resources/Sensitive` subtree before traversal. It also checks that the MCP abstention route
reads known-query evidence and treats a dry query as a hint, not proof of absence. The app
fixture checks Markdown link extraction, exact duplicate grouping, same-title and unsafe-source
flags, stage progression, preservation of missing indexed rows as exceptions, refresh
invalidation, addition of a source without revoking earlier approvals, and a prompt-injection
fixture treated as source text with no general shell/write/download tools exposed. This verifies
the MCP boundary, not model resistance in a real chat. The terminal
`verify-install.sh` check passes 8 gates with one expected unlabeled warning. The PDF extraction
fixture runs with `PATH=/usr/bin:/bin`, excluding Homebrew to exercise the PDFKit fallback; this
does not establish clean-account extension startup.
`setup/tests/test_mcp_protocol.sh`
verifies startup and tool discovery before any brain or source folder exists.
`setup/tests/test_mcp_package.sh` builds the MCPB, checks its checksum and manifest entry
point, then runs protocol, first-run onboarding, selected-root indexing/search, permission,
write-back, same-version package-replacement/uninstall simulation, retrieval-plumbing,
freshness, taxonomy-parity, and terminal-capture fixtures against the extracted server and
packaged engine. `bin/relationships.sh` exposes the shared
evidence-only relationship core to Terminal; `bin/taxonomy.sh` shares proposal and confirmed
folder-label rules with the app. These checks prove local engine/MCP behavior, not the Desktop
settings UI or extension lifecycle in Claude Desktop.

## Prototype asset inventory

All prototype sources below remain untouched in the separate prototype worktree until an
adapted product copy passes its checks. The product engine stays authoritative.

| Prototype asset | Product destination or disposition | Migration notes |
|---|---|---|
| `bundles/databrain/server/main.py` | `setup/mcp/server.mjs` | Replaced with Node stdio MCP source, first-chat setup tools, local shared-engine calls, and no general shell/file-write tool. Permission and lifecycle gaps remain. |
| `bundles/databrain/server/run.sh` | `setup/mcp/` launcher | Rebuild around a bundled engine snapshot and verified runtime; current launcher expects an existing `.engine` and host dependencies. |
| `bundles/databrain/server/run-windows.ps1` | Preserve under pilot; evaluate for a later Windows adapter | Mac is the first release. Do not claim Windows acceptance. |
| `bundles/databrain/manifest.json` | `setup/mcp/manifest.json`, after runtime and permission-boundary review | Current dirty manifest grants one existing “documents” directory and defaults to the pilot folder; it does not express the requested setup flow. Do not copy as-is. |
| `bundles/databrain.mcpb` | Reproducibly rebuild at `setup/packaging/databrain.mcpb` | Current 17 KB package omits the engine and uses the pilot configuration. It is not a release candidate. |
| `bin/setup.sh` (pilot adapter) | Keep terminal route separate; move only any reviewed MCP-specific orchestration to `setup/mcp/` | It clones a pinned engine but currently accepts one source and checks Git/SQLite/rg/Python. Review the dirty version at migration time. |
| `INSTALL.md` (pilot) | Keep as pilot history; adapt accurate privacy disclosure into product app docs after behavior is verified | Its instructions still require manual folder gathering and Terminal and identify the pilot path. The no-copy and hosted-excerpt disclosure is useful but must match the final server cap. |
| `docs/databrain-setup-guide.html` | Replace with product app-guide source under `setup/docs/` after acceptance | Current dirty guide remains Terminal-first, has a single gathered folder, uses the pilot GitHub URL, and includes a Windows/WSL section. It cannot describe the requested novice route. |
| `docs/databrain-terminal-setup-guide.html` | `setup/docs/databrain-terminal-setup-guide.html` | Keep separate from the app guide; verify terminal claims against current product behavior before rendering. |
| `docs/render-setup-guide.py` | `setup/docs/render-setup-guide.py` | Reuse only after checking dependencies and link/text extraction in the product build. |
| Pilot `.engine/` | Do not copy into product or package | It is a generated checkout, not the product source of truth. Rebuild from this repository at a pinned product commit. |
| `bundles/cynthia/**`, `bundles/cynthia.mcpb`, `SETUP.md`, `CLAUDE-APP-MCP.md`, `WALKTHROUGH.md`, `prepare-for-pilot.md`, `example-archive/**`, root `install.sh` | Retain in pilot | Cynthia, pilot-specific content, and old route material are not DataBrain product assets. Reassess references only after the product flow exists; do not move or delete them. |
