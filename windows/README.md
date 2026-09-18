# Data Brain for Windows (WSL 2)

This directory is the Windows-specific entry point. It does not modify or
replace the macOS-ready `bin/` implementation.

## Install in WSL 2

1. Install Ubuntu through WSL 2 and clone this repository inside the Linux
   filesystem, for example `~/src/data-brain`.
2. Install dependencies in that WSL distribution:

   ```bash
   sudo apt update
   sudo apt install -y bash python3 ripgrep sqlite3
   ```

3. Prove SQLite has FTS5, then start the Data Brain installer:

   ```bash
   sqlite3 :memory: "CREATE VIRTUAL TABLE t USING fts5(x);"
   bash windows/install-wsl.sh
   ```

Use `bash windows/data-brain-wsl.sh <command> [arguments]` for normal
commands, for example `fts "project notes" 5`, `refresh`, or `verify`.

The launcher adds Windows-only `stat` and `date` compatibility shims ahead of
the original scripts. Original note roots may be Windows directories mounted
under `/mnt/c/...`; keep Data Brain's repository and derived `moc/` state in
the WSL filesystem. Cloud-only files are never hydrated automatically.
