#!/usr/bin/env bash
# cloud-scan.sh must not start a program per online-only file (that took minutes on a large iCloud): one walk, one pass. Counted with stubs on PATH.
# Also checks the answer: sidecar and search-row files skipped (absolute and ~ spelling), the rest listed with sizes, Google shortcuts listed.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-cloudscan-fast.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
home="$SCRATCH/home"; root="$home/Docs"; moc="$SCRATCH/moc"; bin="$SCRATCH/bin"; calls="$SCRATCH/calls.log"
mkdir -p "$root/a" "$root/b" "$moc/extracted" "$bin"; : > "$calls"
for i in $(seq 1 300); do printf 'file %s\n' "$i" > "$root/a/f$i.md"; done
printf 'pdf\n' > "$root/b/book.pdf"; printf '{}' > "$root/b/link.gdoc"
printf '%s\n' "$root" > "$SCRATCH/roots.txt"
# 10 files with a sidecar (absolute spelling), 5 with a search row that uses the ~ spelling
for i in $(seq 1 10); do h="$(printf '%s' "$root/a/f$i.md" | shasum | cut -c1-16)"; printf 'x\nx\ntext\n' > "$moc/extracted/$h.txt"; done
/usr/bin/sqlite3 "$moc/fts.db" "CREATE VIRTUAL TABLE notes USING fts5(path UNINDEXED, title, themes, keywords, body);"
for i in 11 12 13 14 15; do /usr/bin/sqlite3 "$moc/fts.db" "INSERT INTO notes VALUES('~/Docs/a/f$i.md','t','-','-','indexed text');"; done
{ for i in $(seq 1 300); do printf '%s\n' "$root/a/f$i.md"; done; printf '%s\n' "$root/b/book.pdf"; } > "$SCRATCH/dataless.txt"
for tool in shasum stat grep cut; do
  printf '#!/bin/bash\necho %s >> "%s"\nexec /usr/bin/%s "$@"\n' "$tool" "$calls" "$tool" > "$bin/$tool"; chmod +x "$bin/$tool"
done
real_stat=/usr/bin/stat
HOME="$home" PATH="$bin:/usr/bin:/bin:/usr/sbin:/sbin" NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" NB_TEST_DATALESS_LIST="$SCRATCH/dataless.txt" \
  bash "$PROJECT_ROOT/bin/cloud-scan.sh" > "$SCRATCH/run.log" 2>&1 || { cat "$SCRATCH/run.log" >&2; fail "cloud-scan aborted"; }
pending="$moc/cloud-pending.tsv"
[ "$(wc -l < "$pending" | tr -d ' ')" = 286 ] || fail "expected 286 pending (301 online-only minus 15 already indexed), got $(wc -l < "$pending")"
! grep -q "/a/f1.md" "$pending" || fail "sidecar file listed"
! grep -q "/a/f12.md" "$pending" || fail "search-row file (~ spelling) listed"
grep -q "/a/f16.md	" "$pending" || fail "never-indexed file missing"
[ "$(grep "book.pdf" "$pending" | cut -f2)" = 4 ] || fail "size wrong"
[ "$(cat "$moc/cloud-shortcuts.tsv")" = "$root/b/link.gdoc" ] || fail "shortcut not listed"
n="$(wc -l < "$calls" | tr -d ' ')"
[ "$n" -lt 40 ] || fail "$n program starts for 301 online-only files: a program is started per file again"
echo "PASS: cloud-scan answers correctly with $n program starts for 301 online-only files (no per-file work)."
