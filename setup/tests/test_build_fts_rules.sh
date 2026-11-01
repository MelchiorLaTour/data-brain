#!/usr/bin/env bash
# The search index builder keeps every privacy and folder rule on EVERY row, in a full build and in an incremental one:
# a row outside the selected folders, an artifact, a file the user's privacy review excluded, a symlink that points outside, and a
# file inside a symlinked folder are never indexed, while ordinary files (including an extract-sidecar row) are.
set -euo pipefail

ENGINE="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-fts-rules.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
src="$SCRATCH/src"; outside="$SCRATCH/outside"; moc="$SCRATCH/brain/moc"
mkdir -p "$src/a" "$src/NewBrain/research" "$outside/dir" "$moc/extracted"
printf '%s\n' "$src" > "$SCRATCH/roots.txt"
export NB_MOC_DIR="$moc" NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" NB_PRIVACY_FILE="$SCRATCH/privacy.tsv"

printf 'okmarker ordinary note\n' > "$src/a/ok.md"
printf 'okmarker2 second ordinary note\n' > "$src/a/ok2.md"
printf 'heldmarker the user excluded this\n' > "$src/a/held.md"
printf 'artifactmarker plan machinery\n' > "$src/NewBrain/research/plan.md"
printf 'outsidemarker not in a selected folder\n' > "$outside/out.md"
printf 'linkmarker the target of a symlink outside\n' > "$outside/target.md"
printf 'dirmarker inside a symlinked folder\n' > "$outside/dir/in.md"
ln -s "$outside/target.md" "$src/a/link.md"
ln -s "$outside/dir" "$src/a/linkdir"
printf '%%PDF fake\n' > "$src/a/scan.pdf"
printf 'excluded\t%s\tby the user\n' "$src/a/held.md" > "$SCRATCH/privacy.tsv"

{
  printf '# path\ttitle\tthemes\tkeywords\n'
  for f in "$src/a/ok.md" "$src/a/ok2.md" "$src/a/held.md" "$src/NewBrain/research/plan.md" "$outside/out.md" "$src/a/link.md" "$src/a/linkdir/in.md" "$src/a/scan.pdf"; do
    printf '%s\tTitle of %s\tgroup\tkw\n' "$f" "$(basename "$f")"
  done
} > "$moc/index.tsv"
# the privacy review's own step, as the indexing run does it: excluded rows leave the index
/usr/bin/perl "$ENGINE/bin/privacy.pl" prune-index "$moc/index.tsv"
[ -f "$moc/index.tsv.priv" ] && mv "$moc/index.tsv.priv" "$moc/index.tsv"

fail() { echo "FAIL: $*" >&2; exit 1; }
hits() { sqlite3 -readonly "$moc/fts.db" "SELECT count(*) FROM notes WHERE notes MATCH '$1';"; }
paths() { sqlite3 -readonly "$moc/fts.db" "SELECT path FROM notes ORDER BY path;"; }
check() {
  local when="$1" word
  [ "$(hits okmarker)" = 1 ] && [ "$(hits okmarker2)" = 1 ] || fail "$when: ordinary files must be indexed"
  for word in heldmarker artifactmarker outsidemarker linkmarker dirmarker; do
    [ "$(hits "$word")" = 0 ] || fail "$when: $word must NOT be indexed"
  done
  paths | grep -q 'out.md' && fail "$when: a row outside the selected folders is in the index"
  paths | grep -q 'NewBrain/research' && fail "$when: an artifact is in the index"
  paths | grep -q 'held.md' && fail "$when: a file the user excluded is in the index"
  true
}

# an extract sidecar for the pdf row, so the sidecar fingerprint path runs
hash="$(printf '%s' "$src/a/scan.pdf" | shasum | cut -c1-16)"
printf 'sidecar text pdfmarker\n' > "$moc/extracted/$hash.txt"

out="$(bash "$ENGINE/bin/build-fts.sh" 2>&1)" || fail "full build: $out"
echo "$out" | grep -q 'fts mode: full' || fail "first build must be full: $out"
check "full build"
sig_pdf="$(sqlite3 -readonly "$moc/fts.db" "SELECT sig FROM sig WHERE path LIKE '%scan.pdf'")"
case "$sig_pdf" in *'|'*:*'|'*:*) ;; *) fail "the sidecar row has no sidecar fingerprint: $sig_pdf" ;; esac

printf 'okmarker ordinary note, edited\n' > "$src/a/ok.md"
printf 'linkmarker changed target\n' > "$outside/target.md"
out="$(bash "$ENGINE/bin/build-fts.sh" 2>&1)" || fail "incremental build: $out"
echo "$out" | grep -q 'fts mode: incremental' || fail "second build must be incremental: $out"
check "incremental build after an edit"
[ "$(hits edited)" = 1 ] || fail "the edited ordinary file must be re-read"
echo 'PASS: privacy and folder rules hold on every row in full and incremental builds (outside rows, artifacts, excluded files, symlinks, symlinked folders are never indexed)'
