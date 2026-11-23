#!/usr/bin/env bash
# An online-only file whose earlier extraction ended FINAL (no text layer, or an extractor failure) and whose size and mtime are unchanged must not
# be opened (opened = downloaded) again by extract.sh. The final outcome is stored with "size:mtime" (never ctime, iCloud moves that alone); an older
# report without that column counts as unchanged while the file's mtime is not newer than the report. A changed file is read again.
# Online-only is simulated with NB_TEST_DATALESS_LIST and chmod 000; pdftotext is a stub that logs every call.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-extract-final.XXXXXX")"
trap 'chmod -R u+rw "$SCRATCH" 2>/dev/null; rm -rf "$SCRATCH"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
root="$SCRATCH/root"; moc="$SCRATCH/brain/moc"; bin="$SCRATCH/bin"; calls="$SCRATCH/calls.log"
mkdir -p "$root" "$moc/extracted" "$bin"; root="$(cd "$root" && pwd -P)"; : > "$calls"
printf '%s\n' "$root" > "$SCRATCH/roots.txt"
cat > "$bin/pdftotext" <<SH
#!/bin/bash
# extract.sh hands over a staged copy, so the file is recognised by its content
c="\$(tr -d '\n' < "\$2")"; echo "\$c" >> "$calls"
case "\$c" in broken*) exit 1 ;; esac
exit 0
SH
chmod +x "$bin/pdftotext"
printf 'scan one\n' > "$root/scan.pdf"; printf 'broken one\n' > "$root/broken.pdf"
{ printf '%s\tScan\t-\t-\n' "$root/scan.pdf"; printf '%s\tBroken\t-\t-\n' "$root/broken.pdf"; } > "$moc/index.tsv"
: > "$SCRATCH/dataless.txt"
run() { PATH="$bin:/usr/bin:/bin" NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" NB_TEST_DATALESS_LIST="$SCRATCH/dataless.txt" bash "$PROJECT_ROOT/bin/extract.sh" > "$SCRATCH/run.log" 2>&1 || { cat "$SCRATCH/run.log" >&2; fail "extract.sh aborted"; }; }
rep="$moc/extract-report.tsv"
run   # on this Mac: both end final
grep -Eq "scan\.pdf	no_text_layer	[0-9]+:[0-9]+$" "$rep" || { cat "$rep" >&2; fail "no_text_layer is stored with size:mtime"; }
grep -Eq "broken\.pdf	extraction_failed	[0-9]+:[0-9]+$" "$rep" || { cat "$rep" >&2; fail "extraction_failed is stored with size:mtime"; }
[ "$(wc -l < "$calls" | tr -d ' ')" = 2 ] || fail "first run reads both files once"
# 1. offloaded and unchanged: not opened again (a ctime-only move: chmod changes ctime)
printf '%s\n%s\n' "$root/scan.pdf" "$root/broken.pdf" > "$SCRATCH/dataless.txt"; chmod 000 "$root/scan.pdf" "$root/broken.pdf"
: > "$calls"; run
[ ! -s "$calls" ] || { cat "$calls" >&2; fail "an online-only file with a final outcome was read (downloaded) again"; }
grep -Eq "scan\.pdf	no_text_layer	[0-9]+:[0-9]+$" "$rep" || { cat "$rep" >&2; fail "the final outcome and fingerprint are kept"; }
grep -q 'open_failed\|download_failed' "$rep" && fail "an online-only file was opened"
# 2. an older report with no fingerprint column: still unchanged while the file is not newer than the report
awk -F'\t' -v OFS='\t' 'NR>1 { print $1, $2; next } { print }' "$rep" > "$rep.old" && mv "$rep.old" "$rep"
: > "$calls"; run
[ ! -s "$calls" ] || { cat "$calls" >&2; fail "an old report without fingerprints made extract read an unchanged online-only file"; }
grep -Eq "scan\.pdf	no_text_layer	[0-9]+:[0-9]+$" "$rep" || fail "the fingerprint is filled in on the next run"
# 3. the file changed (size): read again
chmod 644 "$root/scan.pdf"; printf 'scan two with a different size\n' > "$root/scan.pdf"; chmod 000 "$root/scan.pdf"
: > "$calls"; chmod u+r "$root/scan.pdf"; run
grep -q '^scan two' "$calls" || fail "a changed online-only file is read again"
grep -q '^broken' "$calls" && fail "the unchanged one is still left alone"
echo "PASS: extract.sh keeps final outcomes with size:mtime, leaves unchanged online-only files alone (also with an old report), and reads a changed one again."
