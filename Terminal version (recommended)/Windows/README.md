# DataBrain: Terminal version (recommended), Windows

DataBrain runs on Windows inside **WSL 2** (Windows Subsystem for Linux, the
Ubuntu that ships with Windows). The engine is shared with macOS and lives in
the [macOS folder](../macOS) next to this one; it detects Linux by itself. This
folder holds the Windows installer, launcher and tests.

## Download and install

1. Open **PowerShell** and run `wsl --install`, then restart the computer.
   Open **Ubuntu** from the Start menu.
2. In Ubuntu, install the tools DataBrain needs:

   ```bash
   sudo apt update
   sudo apt install -y git python3 ripgrep sqlite3 jq pandoc poppler-utils
   ```

3. Download DataBrain inside Ubuntu (not into a Windows folder) and install it:

   ```bash
   git clone https://github.com/MelchiorLaTour/data-brain.git ~/data-brain
   cd ~/data-brain/"Terminal version (recommended)"
   bash Windows/install-wsl.sh
   ```

Your notes can stay in Windows folders: Ubuntu sees `C:\Users\you\Documents`
as `/mnt/c/Users/you/Documents`. Keep DataBrain itself and its `moc/` search
data inside Ubuntu, as in step 3.

## Daily use

Both forms work: `bash macOS/bin/fts.sh "project notes" 5` or
`bash Windows/data-brain-wsl.sh fts "project notes" 5`.

`pandoc` and `poppler-utils` let DataBrain read the text inside Word files and
PDFs; without them only file names get indexed. `jq` is needed by
`macOS/bin/register-digest-hook.sh`, which sets a 30-second startup limit on
WSL because a cold WSL start takes several seconds.

## Current limits

- **OneDrive online-only files are not protected yet.** On a Mac, DataBrain
  skips iCloud files that are only in the cloud. Nothing does that for OneDrive
  "Files On-Demand" yet, so indexing a OneDrive folder may download them. Set
  the folder to "Always keep on this device" first, or index a local folder.
- **No nightly refresh.** Run `bash macOS/bin/refresh.sh` yourself for now.
- **Huge PDFs:** the Mac uses Spotlight's page count to index very long PDFs
  by name only; on Windows only the file-size limit applies.

## Tests

`python3 -m unittest discover -s Windows/tests -v` (Linux / WSL). GitHub runs
them on Ubuntu for every change.
