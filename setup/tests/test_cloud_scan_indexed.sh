#!/usr/bin/env bash
# cloud-scan.sh must not list an online-only file that was already indexed with text (search row with a body, or an extract sidecar):
# it is not waiting for anything, and listing it inflated "not indexed" and queued a pointless re-download. A never-indexed one is still listed.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/databrain-cloudscan.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT
root="$SCRATCH/root"; moc="$SCRATCH/brain/moc"
mkdir -p "$root" "$moc/extracted"; root="$(cd "$root" && pwd -P)"
printf '%s\n' "$root" > "$SCRATCH/roots.txt"
for n in infts sidecar fresh; do printf 'body %s\n' "$n" > "$root/$n.md"; done
/usr/bin/sqlite3 "$moc/fts.db" "CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, title, themes, keywords, body); INSERT INTO notes VALUES('$root/infts.md','t','-','-','indexed text');"
h="$(printf '%s' "$root/sidecar.md" | shasum | cut -c1-16)"; printf 'x\nx\nsome text\n' > "$moc/extracted/$h.txt"
printf '%s\n%s\n%s\n' "$root/infts.md" "$root/sidecar.md" "$root/fresh.md" > "$SCRATCH/dataless.txt"
NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" NB_TEST_DATALESS_LIST="$SCRATCH/dataless.txt" bash "$PROJECT_ROOT/bin/cloud-scan.sh" > "$SCRATCH/run.log" 2>&1 || { cat "$SCRATCH/run.log" >&2; echo "FAIL: cloud-scan aborted" >&2; exit 1; }
got="$(cut -f1 "$moc/cloud-pending.tsv")"
[ "$got" = "$root/fresh.md" ] || { echo "FAIL: only the never-indexed file may be pending, got:" >&2; echo "$got" >&2; exit 1; }
echo "PASS: cloud-scan lists only online-only files that were never indexed with text."
