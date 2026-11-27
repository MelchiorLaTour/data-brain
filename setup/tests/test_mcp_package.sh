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
    'bin/build-fts.sh', 'bin/build-fts-fr.sh', 'bin/build-index.sh', 'bin/canon.sh', 'bin/extract.sh',
    'bin/fts.sh', 'bin/index-add.sh', 'bin/ingest-root.sh', 'bin/inventory.sh',
    'bin/look.sh', 'bin/rebuild.sh', 'bin/relationships.sh', 'bin/refresh.sh', 'bin/taxonomy.sh',
    'bin/prune-missing.sh', 'bin/privacy.pl', 'bin/privacy-names.sh', 'bin/cloud-scan.sh',
    'setup/mcp/freshness-core.mjs',
    'setup/mcp/github-release-check.mjs', 'setup/mcp/codex-state.mjs', 'setup/mcp/pdf-extract.js',
    'setup/mcp/relationship-core.mjs', 'setup/mcp/server.mjs', 'setup/mcp/package-identity.mjs',
    'setup/mcp/taxonomy-core.mjs', 'setup/mcp/app-readers.mjs', 'setup/mcp/app-policy.mjs', 'setup/mcp/test-hooks.mjs',
    'setup/mcp/hosts/chatgpt.mjs',
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
    '--databrain-source-roots', '${user_config.source_roots}',
], 'MCPB must pass all settings-selected source roots as argv values'
assert list(manifest['user_config']) == ['source_roots'], 'the settings screen must have no data_parent field'
assert manifest['user_config']['source_roots']['type'] == 'directory'
assert manifest['user_config']['source_roots']['multiple'] is True
PY

run_gate 'MCP protocol' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" bash "$HERE/tests/test_mcp_protocol.sh"
run_gate 'Client-visible instruction guidance' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_initialize_instructions.mjs"
run_gate 'Client-visible tool guidance budget' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_tool_guidance_budget.mjs"
run_gate 'Section-aware source health' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_health_section_rows.mjs"
run_gate 'Read privacy boundary' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_read_privacy_race.mjs"
run_gate 'Privacy storage failures fail closed' node "$HERE/tests/test_mcp_privacy_failure_closed.mjs" "$STAGE"
run_gate 'Native held-file approval' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_privacy_consent.mjs"
run_gate 'Production test-hook guard' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_test_hooks_guard.mjs"
run_gate 'App-reader interpreter timeouts' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_app_reader_timeouts.mjs"
run_gate 'Pending app content without active index worker' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" DATABRAIN_TEST_SCRATCH_ROOT="$TEST_PACKAGE_DIR" node "$HERE/tests/test_mcp_health_app_pending_no_worker.mjs"
run_gate 'Startup app check folder freshness' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" DATABRAIN_TEST_SCRATCH_ROOT="$TEST_PACKAGE_DIR" node "$HERE/tests/test_mcp_startup_app_check_folder_freshness.mjs"
run_gate 'GitHub release audit' node "$HERE/tests/test_github_release_check.mjs" "$STAGE"
run_gate 'MCP onboarding' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_onboarding.mjs"
run_gate 'Codex private connection state' node "$HERE/tests/test_codex_state.mjs"
run_gate 'Codex package identity' node "$HERE/tests/test_codex_identity.mjs"
run_gate 'Codex onboarding' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_codex_onboarding.mjs"
run_gate 'MCP Desktop settings' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_desktop_settings.mjs" "$STAGE"
run_gate 'Renumbered disk keeps folder approvals' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_root_renumber.mjs" "$STAGE"
run_gate 'Captured note keeps the brain ready' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_capture_label.mjs"
run_gate 'Restart simulation' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_restart_safety.mjs"
run_gate 'Self-repair' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_repair.mjs"
run_gate 'Uninstall then reinstall reuses the brain' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_reinstall_reuses_brain.mjs"
run_gate 'Guide repair section' node "$HERE/tests/test_guide_repair_section.mjs"
run_gate 'MCP package replacement/uninstall simulation' node "$HERE/tests/test_mcp_package_lifecycle.mjs" "$STAGE"
run_gate 'MCP retrieval plumbing' node "$HERE/tests/test_mcp_recall.mjs" "$STAGE"
run_gate 'MCP multi-variant read and abstention workflow' node "$HERE/tests/test_mcp_multivariant_workflow.mjs" "$STAGE"
run_gate 'Synthetic recall bars' node "$HERE/tests/test_mcp_recall_exam.mjs" "$STAGE"
run_gate '50-file skewed corpus' node "$HERE/tests/test_mcp_skewed_50file.mjs" "$STAGE"
run_gate 'Taxonomy parity' node "$HERE/tests/test_mcp_taxonomy_parity.mjs" "$STAGE"
run_gate 'Terminal relationship home paths' node "$HERE/tests/test_relationship_home_paths.mjs" "$STAGE"
run_gate 'Freshness core' node "$HERE/tests/test_mcp_freshness_core.mjs" "$STAGE"
run_gate 'Freshness skips credential folders' node "$HERE/tests/test_mcp_freshness_credential_dirs.mjs" "$STAGE"
run_gate 'No windows and no banners' node "$HERE/tests/test_mcp_no_windows.mjs" "$STAGE"
run_gate 'Setup consent in the chat' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_folder_confirm.mjs"
run_gate 'Added folders wait for the yes' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_added_folders_consent.mjs"
run_gate 'Note save folder in the chat' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_note_folder.mjs"
run_gate 'Brain folders inside approved folders' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_brain_folder_excluded.mjs"
run_gate 'Cloud files: download to index, never FAIL' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_cloud_auto.mjs"
run_gate 'Cloud check and fetch' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_cloud.mjs"
run_gate 'Cloud: offloaded file downloaded before fingerprint' bash "$HERE/tests/test_extract_cloud_ctime.sh"
run_gate 'Cloud: indexed offloaded files not pending' bash "$HERE/tests/test_cloud_scan_indexed.sh"
run_gate 'New build over a brain with offloaded files' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_offloaded_survive_upgrade.mjs"
run_gate 'Cloud scan: no program per file' bash "$HERE/tests/test_cloud_scan_fast.sh"
run_gate 'Cloud scan: excluded and settled files not queued' bash "$HERE/tests/test_cloud_scan_settled.sh"
run_gate 'Extract: final online-only files not downloaded again' bash "$HERE/tests/test_extract_final_offloaded.sh"
run_gate 'Cloud: failed download leaves a reason' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_cloud_failure_reason.mjs"
run_gate 'Python environment folders are skipped' bash "$HERE/tests/test_skip_python_envs.sh"
run_gate 'Note saved while another job runs' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_note_during_job.mjs"
run_gate 'Cloud fetch in batches' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_cloud_batches.mjs"
run_gate 'Ingest: one changing file does not stop the pass' bash "$HERE/tests/test_ingest_changing_file.sh"
run_gate 'Cloud fetch: changing file skipped, batches carry on' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_cloud_batch_skip.mjs"
run_gate 'Cloud fetch: batch size, packing, tail work once' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_cloud_batch_speed.mjs"
run_gate 'Ready and stopped in chat, no banners' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_ready_and_notify.mjs"
run_gate 'Guide profile line' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_guide_profile_line.mjs"
run_gate 'Terminal capture' bash "$HERE/tests/test_terminal_capture.sh"
run_gate 'FTS source-swap race' bash "$HERE/tests/test_build_fts_races.sh"
run_gate 'Incremental search index' bash "$HERE/tests/test_build_fts_incremental.sh" "$STAGE"
run_gate 'Auto refresh on use' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_auto_refresh.mjs"
run_gate 'MCP and engine acceptance' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" DATABRAIN_TEST_APP_ENGINE_DIR="$STAGE" bash "$HERE/tests/test_moc_override.sh"
run_gate 'ChatGPT host words and tool hints' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_chatgpt_host_words.mjs"
run_gate 'ChatGPT host folders named in the chat' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_chatgpt_folders_from_chat.mjs"
run_gate 'Privacy controls in both hosts' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_privacy_controls_021.mjs"
run_gate 'ChatGPT host keeps state out of the server files' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_chatgpt_state_location.mjs"
run_gate 'Claude and ChatGPT hosts give the same facts' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_chatgpt_claude_parity.mjs"
run_gate 'ChatGPT folder picker' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_chatgpt_picker.mjs"
# These two build the ChatGPT installer from the repository itself, so they do not use the staged Claude package.
run_gate 'ChatGPT installer' node "$HERE/tests/test_chatgpt_installer.mjs"
run_gate 'Old server retires after an upgrade' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_stale_server.mjs"
run_gate 'Test harness leaves no temp folders' node "$HERE/tests/test_harness_cleanup.mjs"
run_gate 'App check after a restart is cheap' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_app_check_cheap.mjs"
run_gate 'No false "still indexing" warning' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_false_indexing_warning.mjs"
run_gate 'Save a note goes to DataBrain' node "$HERE/tests/test_mcp_note_routing.mjs"
run_gate 'Search stays fast while the freshness check runs' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_loop_stall.mjs"
run_gate 'Reminders and app changes: nothing re-indexed for no change' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_part13_apps.mjs"
run_gate 'Notes keep their freshness baseline after a saved note' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_freshness_after_app_check.mjs"
run_gate 'A broken freshness baseline heals' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_freshness_heals_broken.mjs"
run_gate 'ChatGPT whole journey in a fake home' node "$HERE/tests/test_chatgpt_journey.mjs"
run_gate 'ChatGPT guide' node "$HERE/tests/test_chatgpt_guide.mjs"
run_gate 'Settings-wording leak and resume note (ChatGPT)' node "$HERE/tests/test_chatgpt_leak_wording.mjs"
run_gate 'Improve-the-model recommendation while indexing' node "$HERE/tests/test_chatgpt_privacy_nudge.mjs"
run_gate 'ChatGPT capture title and find-my routing sentence' node "$HERE/tests/test_chatgpt_title_and_routing.mjs"
run_gate 'Left-out files stop making the index stale' node "$HERE/tests/test_left_out_parking.mjs"
run_gate 'A parked left-out file starts no refresh' node "$HERE/tests/test_left_out_wiring.mjs"
run_gate 'Another process updating the index: no job made to wait, apps check not held back' node "$HERE/tests/test_refresh_overlap.mjs"
run_gate 'Every tool call leaves one log line (name, ms, ok/err), never arguments or results' node "$HERE/tests/test_tool_call_log.mjs"
run_gate 'Claude and Codex hosts serve the pre-part-25 tools/list and instructions, and do not need hosts/' node "$HERE/tests/test_claude_host_frozen.mjs"
run_gate 'ChatGPT tool list at most 12,000 characters, every rule still served, private-files list read-only' node "$HERE/tests/test_chatgpt_tool_rules.mjs"
run_gate 'Always-on rule script: written once, before the first table, undone exactly, never over the user' node "$HERE/tests/test_always_on_rule.mjs"
run_gate 'ChatGPT skips ~/Documents/Codex (old rows leave on the next refresh); Claude host as shipped' env DATABRAIN_TEST_CLIENT=chatgpt node "$HERE/tests/test_codex_output_skipped.mjs"
run_gate 'Two processes ask for housekeeping: one pass runs, the other logs the skip' node "$HERE/tests/test_housekeeping_skip.mjs"
run_gate 'Installer adds the save-a-note skill, never overwrites a foreign folder; uninstaller removes it' node "$HERE/tests/test_chatgpt_skill_install.mjs"
run_gate 'Long or unclosed frontmatter is indexed, no refresh loop' node "$HERE/tests/test_ingest_long_frontmatter.mjs"
run_gate 'Save a note: ask where, say where' node "$HERE/tests/test_chatgpt_note_ask_first.mjs"
run_gate 'Title-only reminders are indexed' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_reminders_title_only.mjs"
run_gate 'Statement and login shapes are held' bash "$HERE/tests/test_privacy_statement_shape.sh" "$HERE/.."
run_gate 'Secrets of every kind are held' bash "$HERE/tests/test_privacy_secret_gaps.sh" "$HERE/.."
run_gate 'No secret reaches any tool result' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_secrets_never_leave.mjs"
run_gate 'Tool results carry facts only' env DATABRAIN_SERVER="$STAGE/setup/mcp/server.mjs" node "$HERE/tests/test_mcp_results_are_facts.mjs"
echo 'Completed built MCPB checksum, manifest entry point, extracted server bootstrap, and packaged-engine fixtures.'
if ((${#failures[@]})); then
  printf 'FAIL: package suite had %s failing gate(s): %s\n' "${#failures[@]}" "${failures[*]}" >&2
  exit 1
fi
