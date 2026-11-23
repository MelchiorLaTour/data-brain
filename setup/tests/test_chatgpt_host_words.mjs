// 0.2.1: under the ChatGPT host nothing the model reads may talk about Claude or Claude's menus: not the tool descriptions, not the
// initialize instructions, not any result or repair line. The Claude host must be unchanged. Read tools carry readOnlyHint; the brain-first
// rule sits in the first 512 characters of the instructions. Invented data only, fake HOME.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, here, setupFromChat, startChatgpt, writeNotes } from './chatgpt-harness.mjs';

const FORBIDDEN = [/\bClaude\b/i, /extension settings/i, /Settings\s*(?:→|>|->|…)\s*Extensions/i, /Add directory/i, /\bExtensions?\b/, /restart(?:ing)? the extension/i, /\.mcpb\b/i, /\bMCPB\b/, /Desktop extension/i, /custom[\s-]*instruction/i, /personali[sz]ation/i];
const READ_ONLY = ['databrain_cloud_check', 'databrain_diagnostics', 'databrain_search', 'databrain_read', 'databrain_abstain_check', 'databrain_setup_status', 'databrain_health', 'databrain_verify_install', 'databrain_taxonomy_candidates'];
const WRITES = ['databrain_cloud_fetch', 'databrain_privacy', 'databrain_setup_start', 'databrain_select_sources', 'databrain_add_sources', 'databrain_setup_run', 'databrain_capture', 'databrain_file_note', 'databrain_save_synthesis', 'databrain_note_folder', 'databrain_apply_taxonomy', 'databrain_build_relationships', 'databrain_cancel_job', 'databrain_repair', 'databrain_refresh'];

const { temp, home } = await fakeHome('chatgpt-words');
const notes = path.join(home, 'Notes');
await writeNotes(notes, {
  'Trip.md': '# Trip to Brettamoor\nThe train leaves Thursday 08:12 from platform 6. hostwordsmarker\n',
  'Tart.md': '# Ember tart\nBake 34 minutes at 180 C. hostwordsmarker\n',
  'tax return 2025.md': '# Tax\nInvented tax text for the privacy hold. hostwordsmarker\n',
});
const server = startChatgpt({ home, env: { DATABRAIN_TEST_CONSENT: 'ask' } });
const seen = [];   // [label, text]
const record = (label, text) => { seen.push([label, text]); return text; };
const run = async (label, name, args) => record(label, await server.tool(name, args));

try {
  const init = await server.initialize();
  record('instructions', init.instructions);
  const list = (await server.ask('tools/list', {})).result.tools;
  for (const tool of list) record(`tool ${tool.name}`, `${tool.title || ''} ${tool.description} ${JSON.stringify(tool.inputSchema)}`);

  // read-only hints and the repair tool are present; connect_existing is a Codex tool and is hidden
  const names = list.map(tool => tool.name);
  assert(names.includes('databrain_repair') && !names.includes('databrain_connect_existing'), 'repair is offered, connect_existing is not');
  for (const name of READ_ONLY) assert.equal(list.find(tool => tool.name === name)?.annotations?.readOnlyHint, true, `${name} must be readOnlyHint`);
  for (const name of WRITES) assert.notEqual(list.find(tool => tool.name === name)?.annotations?.readOnlyHint, true, `${name} must not be readOnlyHint`);
  assert(list.every(tool => !tool._meta || !('anthropic/alwaysLoad' in tool._meta)), 'no Claude-only tool metadata');

  // the brain-first rule is self-contained and inside the first 512 characters
  const head = init.instructions.slice(0, 512);
  assert(/databrain_search FIRST/.test(head) && /From your files:/.test(head) && /From general knowledge:/.test(head), `brain-first rule is not in the first 512 characters: ${head}`);

  // a normal journey, with the errors a user can run into
  await run('status before', 'databrain_setup_status');
  await run('verify before', 'databrain_verify_install');
  await run('start no folders', 'databrain_setup_start');
  await run('start bad folder', 'databrain_setup_start', { folders: [path.join(home, 'Missing')] });
  await run('start list', 'databrain_setup_start', { folders: [notes] });
  await setupFromChat(server, [notes]);
  await run('status ready', 'databrain_setup_status');
  await run('verify ready', 'databrain_verify_install');
  await run('diagnostics', 'databrain_diagnostics');
  await run('health', 'databrain_health');
  await run('privacy list', 'databrain_privacy', { action: 'list' });
  await run('cloud check', 'databrain_cloud_check');
  await run('repair', 'databrain_repair');
  await run('refresh', 'databrain_refresh');
  await run('add bad folder', 'databrain_add_sources', { folders: [path.join(home, 'Missing')] });
  await run('add no folders', 'databrain_add_sources');
  await run('select list', 'databrain_select_sources', { folders: [notes] });
  await run('read missing', 'databrain_read', { path: path.join(home, 'DataBrain', 'nothing.md') });
  await run('abstain', 'databrain_abstain_check', { query: 'zzqxunmatched' });
  await run('taxonomy', 'databrain_taxonomy_candidates');

  // the checkout itself lives under ~/Claude here; its path is not a host word
  const engineRoot = path.resolve(here, '../..');
  for (const entry of seen) entry[1] = entry[1].split(engineRoot).join('<engine>');
  const bad = [];
  for (const [label, text] of seen) for (const pattern of FORBIDDEN) if (pattern.test(text)) bad.push(`${label}: ${pattern} -> ${text.match(pattern)?.input.slice(Math.max(0, text.search(pattern) - 60), text.search(pattern) + 100).replace(/\s+/g, ' ')}`);
  assert.deepEqual(bad, [], `ChatGPT-host text still names Claude, its menus or Custom Instructions:\n${bad.join('\n')}`);
  // the repair line, when shown, names the right app
  assert(!seen.some(([, text]) => /ask Claude to run DataBrain repair/.test(text)), 'repair line names Claude');
  console.log(`PASS: ChatGPT host: ${seen.length} texts (instructions, ${list.length} tool descriptions, ${seen.length - list.length - 1} results) never name Claude or its menus; ${READ_ONLY.length} read tools have readOnlyHint and ${WRITES.length} write tools do not; the brain-first rule is in the first 512 characters.`);
} finally {
  await server.stop();
}

// the Claude host is unchanged: same server, no ChatGPT flag
const claude = await fakeHome('claude-words');
await writeNotes(path.join(claude.home, 'Notes'), { 'Trip.md': '# Trip\nhostwordsmarker\n' });
// DATABRAIN_TEST_CLIENT=chatgpt would turn this "Claude host" server into a ChatGPT one, so it is pinned to claude here.
const old = startChatgpt({ home: claude.home, env: { DATABRAIN_TEST_CLIENT: 'claude' }, extraArgs: ['--databrain-source-roots', path.join(claude.home, 'Notes')] });
try {
  const init = await old.initialize();
  const list = (await old.ask('tools/list', {})).result.tools;
  const setup = list.find(tool => tool.name === 'databrain_setup_start');
  assert(/Claude Desktop extension settings/.test(setup.description), 'the Claude host keeps its settings wording');
  assert(!('folders' in setup.inputSchema.properties), 'the Claude host has no folders argument');
  assert(list.find(tool => tool.name === 'databrain_search')._meta?.['anthropic/alwaysLoad'] === true, 'the Claude host keeps alwaysLoad');
  assert(/DataBrain repair is available: ask Claude to run DataBrain repair\./.test(list.find(tool => tool.name === 'databrain_diagnostics').description));
  assert.equal(init.instructions.length >= 512, true);
  console.log('PASS: the Claude host is unchanged: settings wording, no folders argument, alwaysLoad and the Claude repair line are kept.');
} finally {
  await old.stop();
}
await fs.rm(temp, { recursive: true, force: true });
await fs.rm(claude.temp, { recursive: true, force: true });
