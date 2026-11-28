# Microsoft / Windows plan

## Recommendation

Support **Windows through WSL 2 first**. Data Brain is a local Bash, ripgrep,
and SQLite CLI application; WSL preserves that contract without a second
PowerShell implementation. The WSL installer and launcher are in
[`../Windows/`](../Windows/README.md); the `bin/` engine is shared with macOS.

SQLite is not a server and needs no special database download. Install the
standard `sqlite3` command-line package inside the chosen WSL distribution,
alongside `bash` and `ripgrep`. Install `pandoc` and Poppler too, or Word and
PDF text is not indexed.

## What it provides

On Linux, `bin/compat.sh` puts `bin/compat/` first on PATH so the BSD `stat`,
`date` and `shasum` forms in `bin/` work unchanged; macOS never loads them.
`setup/tests/test_linux_compat.sh` checks them against GNU coreutils.
`../Windows/data-brain-wsl.sh` remains as a convenience entry point. A native
PowerShell port remains a separate project.

## Acceptance

`../Windows/install-wsl.sh`, `../Windows/data-brain-wsl.sh verify`, ranked search,
and the Windows compatibility tests must pass without accessing files outside
configured canonical roots.

The dependency gate must prove FTS5, not only the executable:

```bash
sqlite3 :memory: "CREATE VIRTUAL TABLE t USING fts5(x);"
```
