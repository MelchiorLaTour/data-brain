# Microsoft / Windows plan

## Recommendation

Support **Windows through WSL 2 first**. Data Brain is a local Bash, ripgrep,
and SQLite CLI application; WSL preserves that contract without a second
PowerShell implementation. The isolated WSL implementation is in
[`windows/`](windows/README.md); the macOS scripts under `bin/` stay unchanged.

SQLite is not a server and needs no special database download. Install the
standard `sqlite3` command-line package inside the chosen WSL distribution,
alongside `bash` and `ripgrep`. `pandoc` and Poppler remain optional extract
tools.

## What it provides

`windows/data-brain-wsl.sh` is the WSL-only command entry point. It supplies
small `stat` and `date` compatibility shims for the BSD forms used by the
unchanged macOS scripts. A native PowerShell port remains a separate project.

## Acceptance

`windows/install-wsl.sh`, `windows/data-brain-wsl.sh verify`, ranked search,
and the Windows compatibility tests must pass without accessing files outside
configured canonical roots.

The dependency gate must prove FTS5, not only the executable:

```bash
sqlite3 :memory: "CREATE VIRTUAL TABLE t USING fts5(x);"
```
