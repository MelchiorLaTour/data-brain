# Claude Desktop acceptance ledger

Updated 2026-09-27. Status describes evidence available in the current worktree, not intent.
PASS requires evidence at the scope stated by the gate. A protocol fixture cannot establish
physical Claude Desktop acceptance.

Local package candidate: `setup/packaging/databrain.mcpb`, package version `0.1.0`,
MCPB manifest schema `0.3`, macOS only, Node runtime declared as `>=18.0.0`. SHA-256 is
recorded in the adjacent `.sha256` file; the builder emits `setup/packaging/databrain.buildinfo.txt`
with repository, source revision, source-tree state, and staged-source digest. The archive's
manifest points to the included server; an extracted-package MCP handshake passed before any
brain existed. The package build is reproducible for the same staged files. Before release, verify that build info identifies the reviewed clean source revision and that the checksum matches the archive.
The archive passes `unzip -t` and contains exactly 23 allowlisted files;
the build test rejects extra or missing payload files. It excludes `bin/kw-dict.tsv` (the
author-corpus-derived dictionary), test fixtures, generated MOC data, local home paths, and
pilot identifiers; the packaged engine retains its sensitive-path exclusion rules.

## Prepared handoff inventory

- Prototype assets moved: none. The prototype worktree and its pre-existing edits remain
  untouched; this product implementation was added directly to the canonical repository.
- Product implementation: shared engine changes are in `bin/`; the Claude Desktop adapter is
  in `setup/mcp/`; the reproducible package builder is in `setup/packaging/`; maintained guide
  sources and disposable acceptance fixtures are in `setup/docs/` and `setup/tests/`.
- Old pilot references: no pilot repository URL or pilot folder path appears in the app,
  Terminal, or recovery guide sources, and the package allowlist excludes pilot-specific files
  and identifiers. `setup/README.md` retains the prototype asset inventory for maintainer
  provenance; that inventory is not an end-user install instruction.
- Signing: the local package is unsigned. Anthropic's [custom extension installation steps](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
  do not list signing as a prerequisite, and the [MCPB CLI documentation](https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md)
  says unsigned MCPBs are valid ZIP files. The latest published CLI remains 2.1.2; its
  signing workflow still has open reports that signed bundles fail Claude Desktop's strict
  ZIP parser ([#278](https://github.com/modelcontextprotocol/mcpb/issues/278)) and that the
  CLI does not cryptographically verify signatures ([#260](https://github.com/modelcontextprotocol/mcpb/issues/260)).
  Keep this package unsigned; confirm its install flow during physical Desktop acceptance.
- Publication state: the unverified GitHub prerelease `v0.1.0` is live at
  https://github.com/MelchiorLaTour/data-brain/releases/tag/v0.1.0. The MCPB, checksum,
  and build-info assets were downloaded back from GitHub and compared byte-for-byte with
  the local files; the package SHA-256 is
  `9cda842d9b3e0dc06942e3465273e576f5224b1b333c5d6690c1efec519ec554`. A one-page prerelease guide is rendered for review under `/private/tmp/databrain-review/`;
  final user-facing PDFs remain withheld pending physical app acceptance.

| Gate | Status | Current evidence | Next required action |
|---|---|---|---|
| Package and bootstrap | LOCAL PACKAGE PASS; synthetic variant recall PASS; v0.1.0 assets VERIFIED; prerelease audit BUG FIXED LOCALLY; held-out and physical app BLOCKED | `bash setup/tests/test_mcp_package.sh` verifies the checksum and exact 23-file allowlist, package version 0.1.0, MCPB manifest schema 0.3, required metadata, Node command and `${__dirname}` entry-point expansion against the [official MCPB manifest spec](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md). A restricted-PATH onboarding run with a temporary Node symlink and only `/usr/bin:/bin:/usr/sbin:/sbin` also passed; this confirms that fixture does not depend on Homebrew paths, but it is not clean-Mac app acceptance. The archive excludes the corpus-derived `kw-dict.tsv`; protocol, onboarding, selected-root search, relationship, freshness, 50-file audit, and note-creation fixtures pass. The package-replacement/uninstall simulation also passes for two extracted copies of the same version; it does not test Claude Desktop's updater. The packaged multi-variant workflow fixture passes search, safe source read, DRY guidance for all-absent variants, and a plausible non-answering decoy read-first route; it does not test Claude generation or judgment. The recall exam retains the single-query baseline as a diagnostic: Easy 10/10, Medium 8/10, Hard 23/40, XLING 2/20, below three unchanged thresholds. Its acceptance route now calls `databrain_abstain_check` with 80 frozen query-only variant rows and scores the union of per-query top-three results: Easy 10/10, Medium 10/10, Hard 40/40, XLING 16/20, meeting the original bars. The 10 all-absent variant probes stayed DRY; 10 plausible traps surfaced candidates on a read-first route. The exam builds the 90-file synthetic corpus and checks derived keywords, then seeds an isolated MCP state from that generated index/FTS database to avoid indexing twice. This proves the variant-search tool path, not Claude-generated variants, held-out personal-corpus recall, answer correctness, citations, or model judgment. The full package suite exits 0 with all local package gates passing. All 90 answer-bearing files receive derived keywords. The official `@anthropic-ai/mcpb` CLI 2.1.2 was fetched into npm’s temporary cache; `mcpb validate setup/mcp/manifest.json` passed and `mcpb info setup/packaging/databrain.mcpb` inspected the archive. The CLI reports it is unsigned. This validates the manifest/package format, not Claude Desktop installation. The package does not bundle the MCP host's Node runtime or OS utilities: Claude Desktop supplies Node, while the engine invokes `/bin/bash`, `sqlite3`, and macOS text/PDF utilities. This Mac has those commands, but a clean supported Mac has not been tested; `sqlite3` is a required runtime dependency and cloud-placeholder recovery also uses `brctl`. `databrain_verify_install` reports the active bundle root, loaded version, and engine revision; audits that active MCP serving the current chat against the GitHub release tagged with its installed version, required package/checksum assets, source commit and release tag; then checks approved-root inventory/index/freshness, confirmed categories/relationship metadata, one known-hit search/read, and an absent-query probe; it discards the local excerpt. This audits the user's active install against the GitHub release's recorded intended build and checks the destination/source-folder values passed to the running process against saved setup. It reports original MCPB archive provenance as BLOCKED because Desktop exposes only the unpacked extension, and it cannot inspect Desktop's hidden settings/registration record. A successful tool call proves the active process is serving this chat; extension-manager record, restart persistence, and fresh-chat verification remain BLOCKED because the MCP cannot inspect them. Mocked release-check tests cover exact match, mismatch, missing release/assets/commit/tag, lightweight and bounded nested annotated tags, cycles, oversized responses, and unexpected host/redirect; the live GitHub prerelease is v0.1.0 at https://github.com/MelchiorLaTour/data-brain/releases/tag/v0.1.0. All three assets downloaded back from GitHub match the local files byte-for-byte; the attached package SHA-256 is recorded above. Audit defect found after publication: the shipped v0.1.0 server requests GitHub `/releases/latest`, which excludes prereleases, so its own remote release check is BLOCKED. The locally committed fix requests the exact installed version tag; focused and full package tests pass with a prerelease fixture. The fix is not in the published v0.1.0 package and needs a new versioned package. Settings-based destination and multiple-root behavior, pre-consent protection, add-without-revocation, repeated setup no-clobber, read-only audit mismatch reporting, and revoked-root cleanup pass fixtures. Source approvals bind canonical paths to device/inode identities in both setup state and a private sidecar; MCP and engine fixtures reject replacement folders until explicit re-selection. The actual Claude Desktop settings UI remains untested. Engine fixtures cover partial DOCX extraction repair, interrupted indexing cancellation/restart/resume, relationship-scan cancellation, SQLite corruption, stale selected-root metadata, frontmatter and FTS source-swap races, and a folder-replacement note-write race that leaves the replacement folder untouched. The isolated terminal verifier fixture reports 8 PASS, 0 FAIL, 1 expected unlabeled warning; the direct product-checkout verifier is not runnable against this machine's absent configured `/Users/melchior/Notes` root. Anthropic's [current Desktop help](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) documents custom installation at Settings > Extensions > Advanced settings > Extension Developer > Install Extension. Physical startup and clean-account route remain untested. | Bump the package version, rebuild/retest and prepare a corrected release after approval; then run Claude-generated query and answer checks in a new chat on a clean supported Mac after restart. |
| Permission confinement | LOCAL PASS; physical OS BLOCKED | `bash setup/tests/test_moc_override.sh` verifies selected-root grants, rejects an unindexed outside file and a symlinked generated index, prunes a permission-denied `Resources/Sensitive` subtree before traversal, rejects a selected parent containing DataBrain using canonical paths, and drives source re-selection with disposable roots; revoked index rows, derived text sidecars, and the relationship report are removed. A deterministic parent-symlink swap test proves traversal stays on the opened folder and leaves the index/FTS database unchanged. `bash setup/tests/test_frontmatter_races.sh` swaps an enumerated Markdown source for an outside symlink before frontmatter is read; both `ingest-root.sh` and `build-index.sh` reject it and preserve the prior index byte-for-byte. Source roots with line breaks are rejected before recording; traversal rejects filenames with tabs or line breaks and preserves the previous index. FTS now treats `index.tsv` as derived state, not authorization: it excludes an injected outside path and an in-root symlink instead of reading their content. Extraction also rejects a manually injected symlink row before reading its target. `bash setup/tests/test_extract_races.sh` swaps an indexed source to an outside symlink immediately before open and immediately after descriptor open; both are rejected, the previous derived extract is preserved, and the outside sentinel is absent from DataBrain state. Extraction copies bytes through the verified open descriptor into a private temporary file before invoking document extractors. MCP fixtures also race direct reads and relationship hashing against symlink replacement; the server fails closed and publishes no partial relationship report. Sidecar reads use `O_NOFOLLOW` and verify embedded path/fingerprint markers. MCP instructions mark source text untrusted; protocol tests confirm no general shell, file-write, or download tool is exposed. These checks establish the local boundary, not real-model prompt-injection resistance. The prior in-chat `NSOpenPanel` selection flow is no longer used for initial destination/source setup. The selected-root fixture also swaps a directory at the same path and proves the MCP and packaged engine reject the replacement before search/indexing. The note-write race creates no file in the replacement folder; if the original folder moves after the write child exits but before the server rechecks it, a note may remain in that moved original folder while indexing is rejected. There is no physical Claude Desktop settings run, destination approval, or app/OS permission evidence. | Test Desktop extension settings, destination approval, restart, and macOS folder access in a physically installed Claude extension. |
| Complete setup | LOCAL ENGINE/MCP MECHANICS PASS; CLAUDE CHAT AND PHYSICAL SETUP BLOCKED | The shared engine inventories approved roots, reconciles supported, unsupported, unreadable, empty, and cloud-placeholder files, extracts supported PDF/DOCX text, and derives keywords without changing originals. The full-pipeline exam records keywords for 90/90 answer-bearing files. The packaged 50-file/10-category fixture confirms all records, category counts (20/12/8 plus 2/2/2/1/1/1/1), keyword search 50/50, and no-hit search. Terminal/MCP tests cover taxonomy proposals, confirmed labels, explicit relationships, freshness, refresh, write-back, interruption/recovery, and unchanged originals. Frozen synthetic MCP query variants meet the existing retrieval bars: Easy 10/10, Medium 10/10, Hard 40/40, XLING 16/20; no-hit variants are DRY 10/10 and plausible traps stay read-first 10/10. Single-query diagnostics remain below three bars (Easy 10/10, Medium 8/10, Hard 23/40, XLING 2/20). Manual variants do not prove Claude's own query generation, answer quality, citations, or held-out recall; cross-language behavior and complete setup in a real chat remain unverified. | Complete setup, verification, and known/absent-question checks in a physically installed Claude Desktop extension and fresh chat. |
| Terminal parity | BLOCKED | Disposable terminal baseline remains 8 PASS, 0 FAIL, 1 expected unlabeled warning. `bash setup/tests/test_moc_override.sh` passes synthetic Unicode/space paths, DOCX/PDF retrieval, ranking, refresh, inventory reconciliation, grant rejection, failure preservation, and unchanged originals. The MCP fixture builds an independent terminal MOC and compares indexed coverage, extraction, ranked paths, excerpt, and absent-query result. Relationship reports match exactly. MCP and Terminal share taxonomy proposals and confirmed assignments; fixtures compare proposal text and resulting index semantics. Raw capture, file-note, and synthesis routes record keywords and enter FTS; collision and outside-root tests pass. App note creation now passes keywords through the locked index-add path, and duplicate keywords cannot satisfy the minimum count. Installed-app parity and held-out absence/trap evaluation remain open. | Verify the installed app and held-out retrieval/absence cases. |
| Capture/write-back | LOCAL PASS; app authorization BLOCKED | `bash setup/tests/test_mcp_package.sh` exercises raw capture, categorized note, and synthesis routes through the packaged server. Each destination is selected from a disposable fixture; tests verify an out-of-scope destination is rejected, a filename collision preserves the existing file, supplied keywords are stored in `index.tsv` and retrievable, new content is readable, and an existing canonical note hash is unchanged. `bin/index-add.sh` now honors the app's `NB_MOC_DIR` override so indexing writes into the approved DataBrain destination. | Run each create action in Claude Desktop and confirm chooser behavior, user-request gating, indexing, and original-file preservation. |
| Physical app lifecycle | LEGACY MCP INITIALIZATION OBSERVED; CURRENT PRODUCT APP TEST BLOCKED | Read-only inspection found a `mcpServers.databrain` entry in Claude Desktop config, pointing to `~/Claude/mcp/bundles/databrain/server/run.sh`; its manifest is version 1.2.0, type `binary`. The sanitized `mcp-server-databrain.log` records MCP initialize, initialized, and tools/list on 2026-09-23, advertising `databrain_search`, `databrain_read`, and `databrain_abstain_check`. It contains no `tools/call`: this proves the legacy process initialized and advertised tools, not an actual search/read or self-setup, and it is not evidence that the new public `.mcpb` was installed. Separately, Mel reports a friend completed full-brain setup with a September 17 version and Obsidian in about 1–2 hours; this is prior end-to-end user evidence, not a test of the current public `.mcpb`. The existing Claude Desktop bundle reports version `1.46388.4` but fails strict code-signature verification. This runner has no usable UI session: `DISPLAY` and `WAYLAND_DISPLAY` are unset, process listing is denied, and AppleScript System Events returns error `-10827`. The default Desktop/DataBrain location collides with the protected live brain. No Claude prompt or usage was used for this inspection. | Install the public `.mcpb` in the existing Claude Desktop app and verify its registered path/tools without sending a prompt; complete first-run setup and known/absent search only when Claude usage is available, using an isolated destination and disposable source folders. Do not download another Claude Desktop app. |
| Persona usability | PARTIAL | Six app-route and six terminal-route theory walkthroughs are recorded below. These are one reviewer’s scenario passes, not independent human tests or physical app acceptance. The unverified prerelease and guide are available, but app install/recovery steps have not been physically tested; app usability and recovery remain BLOCKED. The terminal route passes only for the technical personas. | Recheck affected app personas after a physical install; retain physical tests as a separate gate. |
| Static guides | PRERELEASE GUIDE RENDER PASS; FINAL ACCEPTED-PRODUCT GUIDE BLOCKED | The app source links to the live v0.1.0 package. Its one-page prerelease PDF at `/private/tmp/databrain-review/DataBrain-Claude-Desktop-Guide-v0.1.0-review.pdf` was rendered from the maintained HTML source; pdfinfo confirms US Letter/one page, pdftotext confirms selectable instructions, extracted text bounds end at x=532.54 pt and y=676.99 pt within the body, and PDF link annotations contain the MCPB asset URL and Claude Help Center article. The warning states this prerelease has not been installed or tested in Claude Desktop and discloses its release-audit limitation. Anthropic’s current [local MCP help](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) confirms the Settings > Extensions > Advanced settings > Extension Developer > Install Extension path. Separate Terminal and recovery guide review renders remain in `/private/tmp`; final accepted-product guides remain blocked on physical app acceptance. Current-session re-renders of the maintained app, connection-help, and Terminal sources each produced one US Letter page; extracted text retained the install/recovery steps and arrow glyphs, and PDF annotations target the v0.1.0 MCPB and official Claude Help Center URL. Review artifacts are under `/private/tmp/databrain-guide-audit.rJ6Btu/`; this confirms rendering and links, not physical app acceptance. A 2026-09-27 rerender at `/private/tmp/databrain-final-guides.riSzeM/app.pdf` again passed one-page US Letter, download-before-install order, single setup prompt, no Terminal instructions, prerelease warning, original-file protection, and both link-target checks. | Verify install, restart, source selection, setup, and recovery in Claude Desktop before issuing accepted-product guides. |
| Public distribution | PRERELEASE LIVE; ASSETS PREVIOUSLY BYTE-VERIFIED; CURRENT DOWNLOAD RECHECK DNS-BLOCKED; SHIPPED AUDIT BLOCKED ON PRERELEASE; PHYSICAL ACCEPTANCE BLOCKED | GitHub release [`v0.1.0`](https://github.com/MelchiorLaTour/data-brain/releases/tag/v0.1.0) is explicitly labeled unverified. The MCPB, SHA-256 file, and build info were downloaded from the release and matched the local assets byte-for-byte. A prior direct download of each asset matched the local files byte-for-byte; the direct asset URL is embedded in the maintained app guide. A fresh `gh release view` and `curl -L` check on 2026-09-27 failed with `Could not resolve host: github.com`, so current download availability could not be reverified from this environment. Local checksum check passes. Package hash: `9cda842d9b3e0dc06942e3465273e576f5224b1b333c5d6690c1efec519ec554`. The release targets source revision `ced9e02c2527c45a075facb8ebddad8ee72826b2`. | Publish a corrected version after approval, then run install, restart, fresh-chat, setup, and known/absent-query checks in Claude Desktop. |

## Worktree baseline

- Product repo baseline: HEAD `10be9c0cfdcded362e4cac2f85f9f4c3d9accbc8` (`feat: add isolated WSL compatibility layer`), initially clean on 2026-09-25.
- Prototype worktree was already dirty before this task. Preserve its existing edits in `INSTALL.md`, `bin/setup.sh`, `bundles/databrain.mcpb`, `bundles/databrain/manifest.json`, `bundles/databrain/server/main.py`, and `docs/databrain-setup-guide.html`, plus untracked Windows and guide-rendering files.
- The developer machine has an existing DataBrain folder that collides with the proposed default Desktop destination. No tests used or modified that live folder.
- First-party MCP source and native-picker source are in `setup/mcp/`; no prototype files were moved or edited. The local setup route, shared-engine package, and disposable onboarding/indexing/lifecycle tests are implemented and packaged. Physical Claude Desktop acceptance and publication-ready guides remain blocked.

## Measured install objective

The plan's under-one-minute target applies only to download, extension installation, and
connection. It has not been measured. Do not advertise it as achieved; time this phase
separately from corpus setup and record app version, hardware, and failures.

## Theory walkthroughs — 2026-09-27

Six separate reviewers each desk-checked one persona against the product `INSTALL.md`,
current guides, MCP tool contracts, package state, and Claude Desktop install help. These are
theory walkthroughs, not human usability tests: no MCPB was installed in Claude Desktop, and
the direct download is verified and the prerelease is available; install, settings, and setup remain physically unverified.

Synthetic profile for Persona 6 only: three scattered source folders, five supported files
including one PDF and one DOCX, one unsupported file, and no Obsidian dependency. This is a
scenario fixture, not a claim about Mel's files.

| Persona | Route | Exact actions walked through | Confusing term or blocked step | Result |
|---|---|---|---|---|
| 1 — older novice | App | Open the app guide; follow its `.mcpb` link; use Claude → Settings → Extensions → Advanced settings → Extension Developer → Install Extension; configure folders; start a new chat and type “Set up my DataBrain.” | The prerelease is downloadable, but its installation and the Desktop/DataBrain folder selection flow remain unverified physically. | BLOCKED at physical install/setup. |
| 1 — older novice | Terminal | Read `INSTALL.md`; open Terminal; run `./install.sh`; identify missing prerequisites; follow the taxonomy and doctrine steps. | Shell, repository checkout, `rg`, `sqlite3`, and editing root configuration exceed this persona's stated starting ability. | FAIL for novice route; use the app route after its download and guide exist. |
| 2 — basic email/browser user | App | Follow the guide link; save `.mcpb`; install through the documented Extensions path; choose Desktop as the new DataBrain folder location and select source folders; start a new chat with the setup phrase. | The recovery card points to DataBrain connection status and logs under Settings → Extensions; install and recovery remain theory walkthroughs, not human usability tests. | BLOCKED at physical install/setup. |
| 2 — basic email/browser user | Terminal | Download/clone the repository; open Terminal; run install; then edit or confirm selected roots and approve a taxonomy. | Git clone, Terminal, command-line prerequisites, and editing `canon.sh` are unfamiliar. | FAIL for novice route. |
| 3 — ordinary laptop user | App | Follow the guide link; install from the documented menu; select Desktop as the DataBrain location and intended document folders; use the one setup phrase and follow confirmation/category steps. | Extension settings, permissions, restart, and prompt/results remain unverified physically. | BLOCKED at physical install/setup. |
| 3 — ordinary laptop user | Terminal | Install the repository prerequisites; run `./install.sh`; review folder roots; accept categories; run final verification. | Installation requires developer-style tools and a command-line workflow rather than a normal app installer. | FAIL against the app-first novice goal; terminal remains a separate expert route. |
| 4 — confident power user | App | Intended sequence: obtain and install MCPB; set several roots in Extension settings; confirm setup in chat; add with `databrain_add_sources` or revoke omitted roots by replacing the selection. | The release asset is live and checksum-verified; settings UI, restart, and macOS permission behavior remain unverified. | BLOCKED for physical app; local root and revocation mechanics pass fixtures. |
| 4 — confident power user | Terminal | Clone/open the repository; run `./install.sh`; configure multiple roots; confirm taxonomy; use `refresh.sh`; run `verify-install.sh`. | Requires shell access and manual root/taxonomy setup; `verify-install.sh` passes 8 checks with one expected unlabeled warning on the disposable fixture. | PASS for the tested synthetic terminal mechanics; not a novice setup. |
| 5 — technical expert probing boundaries | App | Inspect manifest/server; probe unapproved and raced paths; revoke roots; inspect tool scope and the read-only GitHub release audit. | Local permission and lifecycle fixtures pass; real-model prompt-injection resistance, actual extension registration, a published release, and archive authentication remain unverified. | PARTIAL; synthetic variant bars pass, while real-model judgment and physical app checks remain BLOCKED. |
| 5 — technical expert probing boundaries | Terminal | Inspect `canon.sh` pruning and generated state; run the engine against disposable roots; probe unsupported, unreadable, symlink, and failure paths; compare original hashes. | Fixtures prove selected-root indexing, sensitive-tree pruning, failed FTS preservation, original-file preservation, and source-swap rejection. Real-model response to malicious document instructions and physical OS permissions are not tested by terminal fixtures. | PARTIAL; do not claim the security gate passes. |
| 6 — scattered-file novice, synthetic profile above | App | Intended sequence: install; set Desktop location and three source folders; use the setup phrase and approve; inspect supported/unsupported inventory; confirm categories; build evidence-only relationships; test known and absent questions. | The exact profile and real prompts were not run; the one unsupported item should be reported as an exception; synthetic variant bars pass, but held-out answer quality is unproven. | BLOCKED at physical install/setup and for held-out retrieval acceptance; no personal corpus scanned. |
| 6 — scattered-file novice, synthetic profile above | Terminal | Configure the three roots in `canon.sh`; run install/extraction; confirm categories; refresh; use ranked search and read the source files. | The route requires technical configuration and does not provide the requested guided conversation; held-out recall and source citation behavior remain incomplete. | PARTIAL for shared engine mechanics; novice fit fails; held-out retrieval remains unproven. |

Defects exposed: all six independently reviewed app paths previously stopped at the placeholder download.
After the guide update, the persona 1–3 desk-check confirmed the Settings path is explicit and
the recovery card points to connection status/logs under Settings → Extensions; no actual
novice was recruited, so this is not human usability evidence. The guide also clarifies that
Desktop is the parent location where setup creates a new DataBrain folder and unsupported
files are not searchable. The Terminal route is intentionally expert-facing. No desk check
proves physical app behavior.

## Windows status

Windows remains a separate WSL 2 route; no Windows-native DataBrain or Claude Desktop test
was run. `python3 -m unittest discover -s windows/tests -v` passes 2 tests. The shim tests
cover inode-aware file fingerprints and device/inode directory identity; the integration
test runs index building and FTS through the WSL compatibility layer. This validates the
shim contract, not a physical Windows installation.

## 2026-09-27 resumed-goal recheck

- `bash setup/tests/test_mcp_package.sh` exited 0 in this resumed run. It rebuilt the package
  from clean source revision `da4990db4b2daab66e7824b30ac047a776e5be8d`; the suite passed
  package bootstrap, release-audit, setup-consent, 50-file/10-category indexing and search,
  synthetic retrieval variants, taxonomy, freshness, capture, source-race, and engine fixtures.
  The variant exam met its frozen synthetic thresholds; the raw single-query diagnostic still
  missed Medium, Hard, and XLING bars. No personal corpus or Claude-generated answer was tested.
- The rebuilt local MCPB SHA-256 is
  `6251e855b8070b632b8de1b291d635cb25baa4754d37bc771a71a7e4d481ede2`; its adjacent checksum
  verifies, and MCPB CLI 2.1.2 validates the manifest and identifies the archive as unsigned.
  It remains version 0.1.0 and is not published as a corrected release.
- Two further clean-source builds produced byte-identical MCPBs at revision
  `2f17e99`; current candidate SHA-256 is
  `297de7b004ee9ddebbf5b1d6e28c77dea84e873acad645fdf7aeb3d836e64fe3`. The adjacent checksum,
  MCPB manifest validation, and archive inspection all pass. This candidate also remains
  version 0.1.0 pending the release-version decision.
- `python3 -m unittest discover -s windows/tests -v` passed both Windows-shim tests; this is
  still not a native Windows installation test. The three maintained guides rerendered to
  one-page US Letter PDFs with selectable text under `/private/tmp/databrain-guides-resume-8bxhoged/`.
  The app guide retained its single setup prompt and prerelease warning, omitted Terminal
  instructions, and its PDF URI annotations point to the v0.1.0 MCPB and Anthropic help page.
  These are static-render checks, not app acceptance; final user PDFs remain withheld.
- A no-prompt install attempt against the existing `/Applications/Claude.app` failed:
  `open -a /Applications/Claude.app <databrain.mcpb>` returned LaunchServices
  `kLSNoExecutableErr`. The bundle's `Contents/MacOS/Claude` executable exists and its plist
  names that executable, while `codesign --verify --deep --strict` reports an invalid
  signature and `spctl --assess` reports an internal code-signing error. This does not establish
  the cause of the LaunchServices error. A bounded search found no second Claude.app in
  `/Applications` or `~/Applications`, and no Claude DMG/PKG/ZIP in Downloads, Claude's
  Application Support folder, or the checked Caches tree. MCPB CLI 2.1.2 has package/build
  commands but no Claude Desktop install command, so it cannot substitute for a working app.
  No extension was installed and no Claude prompt or usage was used. Do not download another
  Claude Desktop app; physical extension acceptance remains blocked until the existing app can
  launch.
- A fresh `gh release view` check failed to connect to `api.github.com`; current hosted release
  availability remains unverified. No push or publication was attempted.
- Follow-up audit on 2026-09-27 found the `databrain_verify_install` tool description still
  claimed it compared against the “latest published release,” although the implementation
  checks the exact installed-version tag, including prereleases. The description now matches
  that behavior and names the release-tag/source-commit check. `bash setup/tests/test_mcp_package.sh`
  exited 0 after the correction, including the prerelease audit fixtures and synthetic
  50-file/10-category setup/retrieval. The current local version-0.1.0 test candidate was rebuilt
  from clean source commit `820fd4c78c74eaf21d05aa63b7ae48b412621ccf`; build info records
  `source_tree=clean` and staged-source digest
  `b58fdd8d8607ecb6d455ab879dda2b8dc6ab7f9931135cec4f498fa447f05231`. Its SHA-256 is
  `d8378d644f828f5a99f3340ec0a8ee153cc9c3a528c5856e89181850dac74bd9`, matched by the adjacent
  checksum file; a second clean-source build during the full-suite run produced the same digest.
  The full package suite exits 0 against this clean-source build; focused
  prerelease-audit and protocol tests also pass. Offline MCPB CLI 2.1.2 `validate
  setup/mcp/manifest.json` passes and `info` identifies the archive as unsigned. Current app,
  Terminal, and connection-help PDFs each rerender to one US
  Letter page under `/private/tmp/databrain-guides-current.V96fw8/`; extracted app text retains
  download-before-install order, the single setup prompt, and prerelease warning, and `pdftohtml`
  confirms the MCPB and official Claude Help Center link targets. These are static checks only.
  It remains version 0.1.0 and is not a corrected published release. Physical Claude Desktop
  acceptance, corrected versioned publication, and live download recheck remain open. A fresh
  no-prompt `open -a /Applications/Claude.app` retry again failed with LaunchServices
  `kLSNoExecutableErr` (`-10827`). The separate web fetch of the v0.1.0 release page and asset
  returned cache misses, so it did not resolve the hosted-availability check. No chat was
  opened, no Claude usage was spent, and no files were published.
- The official [MCPB manifest specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md)
  defines `user_config` type `directory`, supports `multiple: true` for multi-folder selection,
  and expands those selected paths into separate argv values. `setup/mcp/manifest.json` uses this
  mapping for the destination parent and source roots; the package suite checks the mapping and
  MCPB CLI 2.1.2 validates the manifest schema. This confirms specification alignment, not the
  actual Claude Desktop settings UI or persisted value expansion.
- The latest `bash setup/tests/test_mcp_package.sh` run on the current worktree exited 0. The
  onboarding fixture now cancels the destination chooser and confirms no DataBrain folder, setup
  state, or source grant is created. The data-route fixture marks one disposable file as a cloud
  placeholder through path-scoped metadata shims; MCP setup reports it, derives searchable
  keywords, writes the expected text sidecar, and permits a scoped read. This exercises the
  engine's selected-placeholder extraction branch, not real iCloud hydration/re-eviction. No
  physical Claude Desktop test or release was performed. The code, tests, guide note, and evidence
  update are committed locally as `1152469`.
- `bash setup/packaging/build.sh` then rebuilt the ignored local candidate from clean commit
  `1152469d66a91f966e9f5898ad9341146eb839b5`; `source_tree=clean` and staged-source SHA-256 is
  `a71311af12604940b98becf4f3d2a122b6d4aaa624ee5750b74d42b4058be322`. The package SHA-256 is
  `110f1f5aceacc0016641719ef0cf0586b25cac76aac8eaf97cfa8d9fc7d2cb01`, matching its adjacent
  checksum. Offline MCPB CLI validation passes and archive inspection reports 200.86 KB, unsigned.
  It remains version 0.1.0, is not the published artifact, and is not approved for release.
- A fresh web open of the published v0.1.0 GitHub release page returned `Cache miss`; hosted
  availability remains unverified, not proven down.
