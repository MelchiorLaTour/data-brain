#!/usr/bin/env bash
# cloud-scan.sh does not queue online-only files that are settled: excluded/held at the privacy review (absolute path in privacy.tsv) and files whose
# extraction ended final (extract-report.tsv uses the ~ spelling) while size and mtime are unchanged. A changed size or mtime queues the file again;
# a ctime-only move does not. A report without fingerprints (older build) counts as unchanged while the file's mtime is not newer than the report.
# `allowed` after `excluded` (last line wins) queues it. Skipped files are listed in cloud-skipped.tsv with their reason.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-cloudscan-settled.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
home="$SCRATCH/home"; root="$home/Docs"; moc="$SCRATCH/moc"; priv="$SCRATCH/privacy.tsv"
mkdir -p "$root" "$moc"
for n in new excl held rel scan1 scan2 scan3 old1 old2; do printf '%s file\n' "$n" > "$root/$n.pdf"; done
printf '%s\n' "$root" > "$SCRATCH/roots.txt"
ls "$root"/*.pdf > "$SCRATCH/dataless.txt"
fp() { stat -f '%z:%m' "$1"; }
printf 'excluded\t%s\tlooks private\nheld\t%s\tname\nexcluded\t%s\tx\nallowed\t%s\tuser kept it\n' "$root/excl.pdf" "$root/held.pdf" "$root/rel.pdf" "$root/rel.pdf" > "$priv"
{ printf '# canonical_path\tstatus\n'
  printf '~/Docs/scan1.pdf\tno_text_layer\t%s\n' "$(fp "$root/scan1.pdf")"        # unchanged: settled
  printf '~/Docs/scan2.pdf\tread_failed\t%s\n' "$(fp "$root/scan2.pdf")"           # size will change: queued
  printf '~/Docs/scan3.pdf\textraction_failed\t%s\n' "$(fp "$root/scan3.pdf")"     # only ctime will move: settled
  printf '~/Docs/old1.pdf\tno_text_layer\n'                                          # old report, file older than the report: settled
  printf '~/Docs/old2.pdf\tno_text_layer\n'                                          # old report, file newer than the report: queued
} > "$moc/extract-report.tsv"
sleep 1.1; touch "$moc/extract-report.tsv"; sleep 1.1
printf 'a longer second version\n' > "$root/scan2.pdf"     # size and mtime change
chmod 600 "$root/scan3.pdf"                              # ctime only
printf 'changed after the report\n' > "$root/old2.pdf"   # newer than the report, no fingerprint
HOME="$home" PATH="/usr/bin:/bin:/usr/sbin:/sbin" NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" NB_TEST_DATALESS_LIST="$SCRATCH/dataless.txt" NB_PRIVACY_FILE="$priv" \
  bash "$PROJECT_ROOT/bin/cloud-scan.sh" > "$SCRATCH/run.log" 2>&1 || { cat "$SCRATCH/run.log" >&2; fail "cloud-scan aborted"; }
queued="$(cut -f1 "$moc/cloud-pending.tsv" | xargs -n1 basename | sort | tr '\n' ' ')"
[ "$queued" = "new.pdf old2.pdf rel.pdf scan2.pdf " ] || fail "queued: $queued (expected new.pdf old2.pdf rel.pdf scan2.pdf)"
sk="$(sort "$moc/cloud-skipped.tsv" | sed "s|$root/||" | tr '\t\n' ': ' )"
[ "$sk" = "excl.pdf:excluded held.pdf:held old1.pdf:no_text scan1.pdf:no_text scan3.pdf:no_text " ] || fail "skipped list: $sk"
echo "PASS: cloud-scan leaves excluded, held and settled no-text files out of the download list (size/mtime decide, ctime does not), lists them with a reason, and queues changed ones."
