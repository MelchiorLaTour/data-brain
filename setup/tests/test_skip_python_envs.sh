#!/usr/bin/env bash
# Python environment folders and the unzipped DataBrain installer folder hold program files, not notes: a folder whose name starts with .conda or .venv, and any folder named site-packages,
# are never indexed (ingest walk, freshness scan), while look-alikes such as notes-conda or venv-trip still are. A brain that indexed such files
# before the rule drops their rows on its next refresh (prune-missing.sh); the files themselves are never touched.
set -euo pipefail
ENGINE="$(cd "${1:-$(dirname "${BASH_SOURCE[0]}")/../..}" && pwd -P)"
SCRATCH="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/databrain-skip-pyenv.XXXXXX")" && pwd -P)"
trap 'rm -rf "$SCRATCH"' EXIT
src="$SCRATCH/src"; moc="$SCRATCH/moc"
mkdir -p "$src/.conda-OLD-unused/lib" "$src/proj/.venv-semantic/lib" "$src/x/site-packages/pkg" "$src/DataBrain-ChatGPT-Installer-0.2.1/payload" "$src/DataBrain-notes" "$src/notes-conda" "$src/venv-trip" "$moc"
printf '%s\n' "$src" > "$SCRATCH/roots.txt"
for f in .conda-OLD-unused/lib/a.md proj/.venv-semantic/lib/b.md x/site-packages/pkg/c.md DataBrain-ChatGPT-Installer-0.2.1/payload/LICENSE.txt DataBrain-notes/d.md notes-conda/n.md venv-trip/t.md ok.md; do printf 'text of %s\n' "$f" > "$src/$f"; done
export NB_CANON_ROOTS_FILE="$SCRATCH/roots.txt" NB_MOC_DIR="$moc"
bad=(".conda-OLD-unused/lib/a.md" "proj/.venv-semantic/lib/b.md" "x/site-packages/pkg/c.md" "DataBrain-ChatGPT-Installer-0.2.1/payload/LICENSE.txt"); good=("notes-conda/n.md" "venv-trip/t.md" "DataBrain-notes/d.md" "ok.md")
# 1. a fresh walk
printf '# header\n' > "$moc/index.tsv"
bash "$ENGINE/bin/ingest-root.sh" "$src" > "$SCRATCH/ingest.log" 2>&1 || { cat "$SCRATCH/ingest.log" >&2; echo "FAIL: ingest aborted" >&2; exit 1; }
for f in "${bad[@]}"; do ! grep -Fq "$src/$f" "$moc/index.tsv" || { echo "FAIL: $f must not be indexed" >&2; exit 1; }; done
for f in "${good[@]}"; do grep -Fq "$src/$f" "$moc/index.tsv" || { echo "FAIL: $f must still be indexed (no over-match)" >&2; cat "$moc/index.tsv" >&2; exit 1; }; done
# 2. the freshness scan (Node) agrees
node --input-type=module -e "
import { scanSelectedFiles } from '$ENGINE/setup/mcp/freshness-core.mjs';
const files = await scanSelectedFiles({ roots: ['$src'] });
const rel = files.map(f => f.slice('$src/'.length)).sort();
const want = ['DataBrain-notes/d.md', 'notes-conda/n.md', 'ok.md', 'venv-trip/t.md'];
if (JSON.stringify(rel) !== JSON.stringify(want)) { console.error('FAIL: freshness scan saw', rel); process.exit(1); }
"
# 3. an existing brain that already holds such rows drops them on refresh, files untouched
{ printf '# header\n'; for f in "${bad[@]}" "${good[@]}"; do printf '%s\tT\t-\t-\n' "$src/$f"; done; } > "$moc/index.tsv"
bash "$ENGINE/bin/prune-missing.sh" > "$SCRATCH/prune.log" 2>&1 || { cat "$SCRATCH/prune.log" >&2; echo "FAIL: prune aborted" >&2; exit 1; }
for f in "${bad[@]}"; do ! grep -Fq "$src/$f" "$moc/index.tsv" || { echo "FAIL: stale row for $f survived the refresh" >&2; exit 1; }; [ -f "$src/$f" ] || { echo "FAIL: $f was touched" >&2; exit 1; }; done
for f in "${good[@]}"; do grep -Fq "$src/$f" "$moc/index.tsv" || { echo "FAIL: row for $f was wrongly dropped" >&2; exit 1; }; done
echo "PASS: .conda*, .venv* and site-packages folders are skipped (walk, freshness scan, stale rows pruned on refresh); notes-conda and venv-trip are still indexed."
