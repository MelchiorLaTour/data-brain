#!/usr/bin/env bash
# One Markdown file that changes while its frontmatter is read must not stop the whole ingest pass.
#  - ctime only moves once (iCloud finishing a download): re-read, indexed, every other row committed.
#  - ctime keeps moving: that one file is left out and listed (path + reason), every other row committed, exit 0.
#  - the file is really replaced (new inode, other text): never indexed with the swapped text; every other row committed.
# The stat stub changes the file right after the "before" fingerprint is taken, which is exactly where the race sits.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-ingest-changing.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

home="$SCRATCH/home"; root="$home/Notes"; moc="$SCRATCH/moc"; bin="$SCRATCH/bin"; marks="$SCRATCH/marks"
mkdir -p "$root" "$moc" "$bin" "$marks"
printf '%s\n' "$root" > "$SCRATCH/roots.txt"
for n in alpha bravo charlie; do printf -- '---\ntags: [tag%s]\n---\n# %s\n' "$n" "$n" > "$root/$n.md"; done
printf -- '---\ntags: [flakyonce]\n---\n# once\n' > "$root/flakyonce.md"
printf -- '---\ntags: [flakyalways]\n---\n# always\n' > "$root/flakyalways.md"
printf -- '---\ntags: [originaltag]\n---\n# swap\n' > "$root/swapme.md"
printf -- '---\ntags: [swappedsecret]\n---\n# swapped\n' > "$SCRATCH/replacement.md"
# same size and same mtime as the original, but a new inode: only the inode tells it apart
printf -- '---\ntags: [origtagtwo]\n---\n# swap\n' > "$root/swapsame.md"
printf -- '---\ntags: [swappedtwo]\n---\n# swap\n' > "$SCRATCH/replacement2.md"

# ctime has one-second resolution: the stub waits past the second of the fingerprint it just took, so the change always shows (it flaked 1 run in 6 before).
# stat stub: on the FIRST fingerprint of a named file, change it (ctime only, or replace it), then answer from the real stat
cat > "$bin/stat" <<'SH'
#!/bin/bash
real=/usr/bin/stat
case "$*" in *'%i:%z:%m:%c'*) ;; *) exec $real "$@" ;; esac
file="${@: -1}"
out="$($real "$@")" || exit $?
key="$STUB_MARKS/$(basename "$file")"
case "$file" in
  */flakyonce.md)   [ -e "$key" ] || { : > "$key"; sleep 1.1; chmod u-w "$file"; chmod u+w "$file"; } ;;
  */flakyalways.md) sleep 1.1; chmod u-w "$file"; chmod u+w "$file" ;;
  */swapme.md)      [ -e "$key" ] || { : > "$key"; cp "$STUB_REPLACEMENT" "$file.new"; mv -f "$file.new" "$file"; } ;;
  */swapsame.md)    [ -e "$key" ] || { : > "$key"; cp "$STUB_REPLACEMENT2" "$file.new"; touch -r "$file" "$file.new"; mv -f "$file.new" "$file"; } ;;
esac
printf '%s\n' "$out"
SH
chmod +x "$bin/stat"

printf '# canonical_path\ttitle\tthemes\tkeywords\n' > "$moc/index.tsv"
set +e
HOME="$home" PATH="$bin:/usr/bin:/bin:/usr/sbin:/sbin" NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" \
  STUB_MARKS="$marks" STUB_REPLACEMENT="$SCRATCH/replacement.md" STUB_REPLACEMENT2="$SCRATCH/replacement2.md" \
  bash "$PROJECT_ROOT/bin/ingest-root.sh" "$root" > "$SCRATCH/out.log" 2>&1
status=$?
set -e
[ "$status" -eq 0 ] || { cat "$SCRATCH/out.log" >&2; fail "one changing file stopped the whole pass (exit $status)"; }

idx="$moc/index.tsv"
for n in alpha bravo charlie; do grep -q "tag$n" "$idx" || fail "$n.md row missing: the pass lost its other rows"; done
grep -q 'flakyonce' "$idx" || fail "file whose ctime moved once was not indexed after the second read"
! grep -q 'flakyalways' "$idx" || fail "file whose ctime kept moving was indexed"
! grep -q 'swappedtwo' "$idx" || fail "same-size same-mtime swap (new inode only) reached the index"
! grep -q 'swappedsecret' "$idx" || fail "swapped text reached the index"
! grep -q 'swapme' "$idx" || fail "a really replaced file got a row"
skip="$moc/ingest-skipped.tsv"
[ -s "$skip" ] || fail "no list of left-out files"
grep -q 'flakyalways.md' "$skip" || fail "persistent file not listed"
grep -q 'swapme.md' "$skip" || fail "swapped file not listed"
grep -q 'swapsame.md' "$skip" || fail "inode-only swap not listed"
! grep -q 'flakyonce' "$skip" || fail "file indexed on the second read must not be listed"
! grep -q 'swappedsecret\|originaltag' "$skip" || fail "list holds content"
grep -q 'left out 3 file' "$SCRATCH/out.log" || fail "count of left-out files not reported"
echo "PASS: a changing file is skipped (or re-read when only ctime moved) without losing the other rows; swapped text never indexed."
