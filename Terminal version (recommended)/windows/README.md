# Data Brain for Windows (WSL 2)

This directory holds the Windows-specific installer and launcher. The engine
in `bin/` is shared with macOS and detects Linux itself (`bin/compat.sh`).

## Install in WSL 2

1. Install Ubuntu through WSL 2 and clone this repository inside the Linux
   filesystem, for example `~/src/data-brain`.
2. Install dependencies in that WSL distribution:

   ```bash
   sudo apt update
   sudo apt install -y git bash python3 ripgrep sqlite3 jq pandoc poppler-utils
   ```

3. Prove SQLite has FTS5, then start the Data Brain installer:

   ```bash
   sqlite3 :memory: "CREATE VIRTUAL TABLE t USING fts5(x);"
   bash windows/install-wsl.sh
   ```

Run commands either way, both work: `bash bin/fts.sh "project notes" 5` or
`bash windows/data-brain-wsl.sh fts "project notes" 5`.

`pandoc` and `poppler-utils` are what let DataBrain read the text inside Word
files and PDFs; without them only file names get indexed. `jq` is needed by
`bin/register-digest-hook.sh`, which sets a 30-second startup limit on WSL
because a cold WSL start takes several seconds.

Original note roots may be Windows directories mounted under `/mnt/c/...`;
keep DataBrain's repository and derived `moc/` state in the WSL filesystem.

## Current limits

- **OneDrive online-only files are not protected yet.** On a Mac, DataBrain
  skips iCloud files that are only in the cloud. Nothing does that for OneDrive
  "Files On-Demand" yet, so indexing a OneDrive folder may download them. Set
  the folder to "Always keep on this device" first, or index a local folder.
- **No nightly refresh.** Run `bash bin/refresh.sh` yourself for now.
- **Huge PDFs:** the Mac uses Spotlight's page count to index very long PDFs
  by name only; on Windows only the file-size limit applies.
