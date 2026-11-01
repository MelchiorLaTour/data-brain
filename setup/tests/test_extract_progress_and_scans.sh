#!/usr/bin/env bash
# extract.sh: (1) a PDF whose extractor runs fine but finds no text is recorded as no_text_layer (a scanned image), apart from a real
# read error (extraction_failed); (2) the progress file counts real extractions apart from earlier results that a resumed run only
# re-checked and skipped. Fake files only; pdftotext is a stub so the result does not depend on the Mac's tools.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-extract-scan.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
root="$SCRATCH/root"; moc="$SCRATCH/brain/moc"; bin="$SCRATCH/bin"
mkdir -p "$root" "$moc/extracted" "$bin"
root="$(cd "$root" && pwd -P)"
printf '%s\n' "$root" > "$SCRATCH/roots.txt"

# stub: TEXTPDF -> text; SCANPDF -> runs fine, prints nothing (no text layer); anything else -> read error (exit 1)
cat > "$bin/pdftotext" <<'SH'
#!/bin/bash
[ -f "$NB_MOC_DIR/extract-progress.txt" ] && cat "$NB_MOC_DIR/extract-progress.txt" >> "$PROGRESS_LOG"
if grep -q TEXTPDF "$2"; then echo "readable words here for $(basename "$2")"; exit 0; fi
if grep -q SCANPDF "$2"; then exit 0; fi
exit 1
SH
chmod +x "$bin/pdftotext"

: > "$moc/index.tsv"
for i in $(seq -w 1 30); do
  printf 'TEXTPDF %s\n' "$i" > "$root/text-$i.pdf"
  printf '%s\tText %s\t-\t-\n' "$root/text-$i.pdf" "$i" >> "$moc/index.tsv"
done
printf 'SCANPDF\n' > "$root/zz-scan.pdf";   printf '%s\tScan\t-\t-\n' "$root/zz-scan.pdf" >> "$moc/index.tsv"
printf 'garbage\n' > "$root/zz-broken.pdf"; printf '%s\tBroken\t-\t-\n' "$root/zz-broken.pdf" >> "$moc/index.tsv"

run() {
  PROGRESS_LOG="$SCRATCH/progress.log" PATH="$bin:/usr/bin:/bin" NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" \
    bash "$PROJECT_ROOT/bin/extract.sh" > "$SCRATCH/run.log" 2>&1 || { cat "$SCRATCH/run.log" >&2; echo "FAIL: extract.sh aborted" >&2; exit 1; }
}

: > "$SCRATCH/progress.log"
run
grep -Fq "$root/zz-scan.pdf"$'\tno_text_layer' "$moc/extract-report.tsv" || { echo "FAIL: the scanned PDF must be recorded as no_text_layer" >&2; cat "$moc/extract-report.tsv" >&2; exit 1; }
grep -Fq "$root/zz-broken.pdf"$'\textraction_failed' "$moc/extract-report.tsv" || { echo "FAIL: the unreadable PDF must stay extraction_failed" >&2; exit 1; }
grep -q 'failed=1  no-text-layer=1' "$SCRATCH/run.log" || { echo "FAIL: summary must count 1 failed and 1 no-text-layer" >&2; cat "$SCRATCH/run.log" >&2; exit 1; }

# second run = a resumed run: the 30 readable PDFs already have results, so they are re-checked and skipped, not counted as work
: > "$SCRATCH/progress.log"
run
grep -q 'processed=2 .*skipped-fresh=30' "$SCRATCH/run.log" || { echo "FAIL: the resumed run must skip the 30 finished files and process only 2" >&2; cat "$SCRATCH/run.log" >&2; exit 1; }
# when the stub ran (rows 31 and 32) the progress file, written at row 25, said: 0 extracted, 24 reused (row 25 is not yet classified), 25 looked at
grep -qx '0 24 25' "$SCRATCH/progress.log" || { echo "FAIL: progress must show 0 extracted / 24 reused / 25 looked at, got:" >&2; cat "$SCRATCH/progress.log" >&2; exit 1; }
[ ! -e "$moc/extract-progress.txt" ] || { echo "FAIL: the progress file must be removed when extraction ends" >&2; exit 1; }
echo 'PASS: scanned PDFs (no text layer) are recorded apart from read errors; a resumed run counts only real extractions as work and reports re-checked files separately.'
