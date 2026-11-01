#!/usr/bin/env bash
# extract.sh never opens a file that is online-only (opening it downloads it): a PDF that was extracted while it was on this Mac and later went
# online-only keeps its sidecar untouched, a text note with no sidecar is left alone, both are reported as cloud_only (not as failures), and a
# normal file next to them is still extracted. Online-only is simulated with NB_TEST_DATALESS_LIST; the "online-only" files are made unreadable
# (chmod 000), so any attempt to open one would show up as open_failed. Fake files only; pdftotext is a stub.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-extract-cloud.XXXXXX")"
trap 'chmod -R u+rw "$SCRATCH" 2>/dev/null; rm -rf "$SCRATCH"' EXIT
root="$SCRATCH/root"; moc="$SCRATCH/brain/moc"; bin="$SCRATCH/bin"
mkdir -p "$root" "$moc/extracted" "$bin"; root="$(cd "$root" && pwd -P)"
printf '%s\n' "$root" > "$SCRATCH/roots.txt"
cat > "$bin/pdftotext" <<'SH'
#!/bin/bash
echo "readable words here for $(basename "$2")"
SH
chmod +x "$bin/pdftotext"
printf 'TEXTPDF cloud\n' > "$root/cloud.pdf"; printf 'TEXTPDF local\n' > "$root/local.pdf"; printf 'plain note, no keywords yet\n' > "$root/cloudnote.txt"
{ printf '%s\tCloud\t-\t-\n' "$root/cloud.pdf"; printf '%s\tLocal\t-\t-\n' "$root/local.pdf"; printf '%s\tCloudnote\t-\t-\n' "$root/cloudnote.txt"; } > "$moc/index.tsv"
run() { PATH="$bin:/usr/bin:/bin" NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" NB_TEST_DATALESS_LIST="$SCRATCH/dataless.txt" bash "$PROJECT_ROOT/bin/extract.sh" > "$SCRATCH/run.log" 2>&1 || { cat "$SCRATCH/run.log" >&2; echo "FAIL: extract.sh aborted" >&2; exit 1; }; }
: > "$SCRATCH/dataless.txt"
run   # everything is on this Mac: all three are extracted or keyworded normally
hash="$(printf '%s' "$root/cloud.pdf" | shasum | cut -c1-16)"
[ -s "$moc/extracted/$hash.txt" ] || { echo "FAIL: setup run did not extract cloud.pdf" >&2; exit 1; }
before="$(shasum "$moc/extracted/$hash.txt")"
# now macOS offloads two of them: simulated, and made unreadable so that opening one would fail loudly
# cloudnote.txt was indexed while it was on this Mac: its search row has text (a text note has no sidecar)
/usr/bin/sqlite3 "$moc/fts.db" "CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, title, themes, keywords, body); INSERT INTO notes VALUES('$root/cloudnote.txt','Cloudnote','-','-','plain note, no keywords yet');"
printf '%s\n%s\n' "$root/cloud.pdf" "$root/cloudnote.txt" > "$SCRATCH/dataless.txt"
chmod 000 "$root/cloud.pdf" "$root/cloudnote.txt"
printf 'TEXTPDF local changed\n' > "$root/local.pdf"; sleep 1.1; printf 'TEXTPDF local changed again\n' > "$root/local.pdf"
run
rep="$moc/extract-report.tsv"
grep -Fq "$root/cloud.pdf"$'\tcloud_only' "$rep" || { echo "FAIL: cloud.pdf must be reported as cloud_only" >&2; cat "$rep" >&2; exit 1; }
grep -Fq "$root/cloudnote.txt"$'\tcloud_only' "$rep" || { echo "FAIL: cloudnote.txt must be reported as cloud_only" >&2; cat "$rep" >&2; exit 1; }
if grep -q 'open_failed\|read_failed' "$rep"; then echo "FAIL: an online-only file was opened" >&2; cat "$rep" >&2; exit 1; fi
[ "$(shasum "$moc/extracted/$hash.txt")" = "$before" ] || { echo "FAIL: the online-only file's sidecar was changed" >&2; exit 1; }
grep -Fq "$root/local.pdf" "$rep" && ! grep -Fq "$root/local.pdf"$'\tcloud_only' "$rep" || { echo "FAIL: the normal file must still be processed" >&2; cat "$rep" >&2; exit 1; }
echo "PASS: extract.sh leaves online-only files alone (no open, sidecar kept, reported as cloud_only, no failure) and still extracts a normal file."
