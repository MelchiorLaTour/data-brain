# Microsoft / Windows plan

## Recommendation

Support **Windows through WSL 2 first**. Data Brain is a local Bash, ripgrep,
and SQLite CLI application; WSL preserves that contract without a second
PowerShell implementation. This is a plan, not current Windows support.

SQLite is not a server and needs no special database download. Install the
standard `sqlite3` command-line package inside the chosen WSL distribution,
alongside `bash` and `ripgrep`. `pandoc` and Poppler remain optional extract
tools.

## Minimal implementation phases

1. Add a platform helper for file modification time and dataless-file checks.
   Replace the current BSD-only `stat -f` usages in `build-fts.sh`, `search.sh`,
   `refresh.sh`, and `recent.sh` with BSD/GNU-compatible helpers.
   Restrict iCloud file-flag handling to macOS.
2. Document the WSL install path and use Task Scheduler or a user-started WSL
   refresh command instead of launchd. Keep the code and derived index in the
   WSL filesystem; configured canonical note roots may be mounted Windows paths
   such as `/mnt/c/...`. Do not claim scheduled refresh works until it has run
   successfully on Windows.
3. Run the existing installer and retrieval checks in WSL on a clean fixture.
   Add an Ubuntu CI job, then record a real WSL result separately.
4. Treat native PowerShell as a later port: it requires replacing the Bash
   runtime contract, not merely installing SQLite.

## Acceptance

`install.sh`, `verify-install.sh`, refresh, ranked search, abstention, and
binary extraction must pass in WSL without accessing files outside configured
canonical roots.

The dependency gate must prove FTS5, not only the executable:

```bash
sqlite3 :memory: "CREATE VIRTUAL TABLE t USING fts5(x);"
```
