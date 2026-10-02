#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$(mktemp -d)"
TEST_PACKAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/databrain-mcpb-test-output.XXXXXX")"
PACKAGE="$TEST_PACKAGE_DIR/databrain.mcpb"
trap 'rm -rf "$STAGE" "$TEST_PACKAGE_DIR"' EXIT

failures=()
run_gate() {
  local name="$1"
  shift
  if "$@"; then
    return 0
  else
    local code=$?
    echo "FAIL: $name (exit $code)" >&2
    failures+=("$name")
    return 0
  fi
}

DATABRAIN_PACKAGING_OUT_DIR="$TEST_PACKAGE_DIR" bash "$HERE/packaging/build.sh" >/dev/null
(cd "$TEST_PACKAGE_DIR" && shasum -a 256 -c databrain.mcpb.sha256 >/dev/null)
unzip -q "$PACKAGE" -d "$STAGE"
cmp "$TEST_PACKAGE_DIR/databrain.buildinfo.txt" "$STAGE/BUILDINFO.txt"
python3 - "$STAGE" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
expected_files = {
    'BUILDINFO.txt', 'LICENSE', 'manifest.json',
    'bin/build-fts.sh', 'bin/build-index.sh', 'bin/canon.sh', 'bin/extract.sh',
    'bin/fts.sh', 'bin/index-add.sh', 'bin/ingest-root.sh', 'bin/inventory.sh',
    'bin/look.sh', 'bin/rebuild.sh', 'bin/relationships.sh', 'bin/refresh.sh', 'bin/taxonomy.sh',
    'bin/prune-missing.sh', 'bin/privacy.pl', 'bin/privacy-names.sh',
    'setup/mcp/folder-picker.js', 'setup/mcp/freshness-core.mjs',
    'setup/mcp/github-release-check.mjs', 'setup/mcp/codex-state.mjs', 'setup/mcp/pdf-extract.js',
    'setup/mcp/relationship-core.mjs', 'setup/mcp/server.mjs', 'setup/mcp/package-identity.mjs',
    'setup/mcp/taxonomy-core.mjs',
}
actual_files = {path.relative_to(root).as_posix() for path in root.rglob('*') if path.is_file()}
assert actual_files == expected_files, (
    f'unexpected or missing MCPB payload files: '
    f'unexpected={sorted(actual_files - expected_files)}, missing={sorted(expected_files - actual_files)}'
)
assert 'bin/kw-dict.tsv' not in actual_files, 'corpus-derived keyword dictionary must not ship in MCPB'

manifest = json.loads((root / 'manifest.json').read_text())
assert manifest['manifest_version'] == '0.3', 'expected current MCPB manifest schema 0.3'
assert manifest['version'] and manifest['description'] and manifest['author']['name']
assert manifest['server']['type'] == 'node'
entry = manifest['server']['entry_point']
assert (root / entry).is_file(), f'missing packaged server entry point: {entry}'
assert manifest['name'] == 'databrain'
config = manifest['server']['mcp_config']
assert config['command'] == 'node'
assert config['args'] == [
    f"${{__dirname}}/{entry}",
    '--databrain-parent', '${user_config.data_parent}',
    '--databrain-source-roots', '${user_config.source_roots}',
], 'MCPB must pass its settings-selected parent and all source roots as argv values'
assert manifest['user_config']['data_parent']['type'] == 'directory'
# optional with a home-folder default: nobody has to choose a location
assert 'default' not in manifest['user_config']['data_parent']
assert manifest['user_config']['data_parent']['required'] is False
assert manifest['user_config']['source_roots']['type'] == 'directory'
assert manifest['user_config']['source_roots']['multiple'] is True
PY

run_gate 'MCP protocol' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" bash "$HERE/tests/test_mcp_protocol.sh"
run_gate 'GitHub release audit' node "$HERE/tests/test_github_release_check.mjs" "$STAGE"
run_gate 'MCP onboarding' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_onboarding.mjs"
run_gate 'Codex private connection state' node "$HERE/tests/test_codex_state.mjs"
run_gate 'Codex package identity' node "$HERE/tests/test_codex_identity.mjs"
run_gate 'Codex onboarding' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_codex_onboarding.mjs"
run_gate 'MCP Desktop settings' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_desktop_settings.mjs" "$STAGE"
run_gate 'MCP package replacement/uninstall simulation' node "$HERE/tests/test_mcp_package_lifecycle.mjs" "$STAGE"
run_gate 'MCP retrieval plumbing' node "$HERE/tests/test_mcp_recall.mjs" "$STAGE"
run_gate 'MCP multi-variant read and abstention workflow' node "$HERE/tests/test_mcp_multivariant_workflow.mjs" "$STAGE"
run_gate 'Synthetic recall bars' node "$HERE/tests/test_mcp_recall_exam.mjs" "$STAGE"
run_gate '50-file skewed corpus' node "$HERE/tests/test_mcp_skewed_50file.mjs" "$STAGE"
run_gate 'Taxonomy parity' node "$HERE/tests/test_mcp_taxonomy_parity.mjs" "$STAGE"
run_gate 'Terminal relationship home paths' node "$HERE/tests/test_relationship_home_paths.mjs" "$STAGE"
run_gate 'Freshness core' node "$HERE/tests/test_mcp_freshness_core.mjs" "$STAGE"
run_gate 'Terminal capture' bash "$HERE/tests/test_terminal_capture.sh"
run_gate 'FTS source-swap race' bash "$HERE/tests/test_build_fts_races.sh"
run_gate 'Incremental search index' bash "$HERE/tests/test_build_fts_incremental.sh" "$STAGE"
run_gate 'Auto refresh on use' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_auto_refresh.mjs"
run_gate 'MCP and engine acceptance' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" DATABRAIN_TEST_APP_ENGINE_DIR="$STAGE" bash "$HERE/tests/test_moc_override.sh"
echo 'Completed built MCPB checksum, manifest entry point, extracted server bootstrap, and packaged-engine fixtures.'
if ((${#failures[@]})); then
  printf 'FAIL: package suite had %s failing gate(s): %s\n' "${#failures[@]}" "${failures[*]}" >&2
  exit 1
fi
