// Check on use (plan 11): a search after files changed answers from the current index, says how many
// files changed, refreshes in the background, keeps the finished setup stage, and afterwards finds
// added/changed files and stops returning deleted ones.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-auto-refresh-')));
const notes = path.join(temp, 'sources', 'notes');
const docs = path.join(temp, 'sources', 'docs');
const parent = path.join(temp, 'parent');
const dataHome = path.join(parent, 'DataBrain');
await Promise.all([notes, docs, parent, path.join(temp, 'home')].map(dir => fs.mkdir(dir, { recursive: true })));
await fs.writeFile(path.join(notes, 'codename.md'), '# Codename\nZephyrquill is the lamp prototype.\n');
await fs.writeFile(path.join(notes, 'garden.md'), '# Garden\nTomatoes need staking in June.\n');
await fs.writeFile(path.join(notes, 'bike.md'), '# Bike\nOil the chain every month.\n');
await fs.writeFile(path.join(docs, 'timetable.txt'), 'Train timetable: platform four at nine.\n');
await fs.writeFile(path.join(docs, 'recipe.txt'), 'Lemon tart needs shortcrust pastry.\n');

const server = spawn(process.execPath, [serverScript, '--databrain-parent', parent, '--databrain-source-roots', notes, docs], {
  env: { ...process.env, HOME: path.join(temp, 'home'), DATABRAIN_FRESHNESS_CHECK_MS: '500' }, stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
server.stderr.setEncoding('utf8'); server.stderr.on('data', part => { stderr += part; });
const replies = new Map();
readline.createInterface({ input: server.stdout }).on('line', line => { const m = JSON.parse(line); replies.get(m.id)?.(m); });
let nextId = 0;
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 30000);
  replies.set(id, m => { clearTimeout(timer); resolve(m); });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, limitMs = 90000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    assert(Date.now() - start < limitMs, `timed out waiting for ${label}`);
    await sleep(300);
  }
}
const idle = async () => !(await call('databrain_setup_status')).includes('refresh: running') || null;
const stageIs = stage => async () => (await call('databrain_setup_status')).includes(`Stage: ${stage}`) || null;
const indexPath = path.join(dataHome, 'moc', 'index.tsv');
const indexRows = async () => (await fs.readFile(indexPath, 'utf8')).split('\n').filter(line => line && !line.startsWith('#'));

try {
  await rpc('initialize', { protocolVersion: '2025-03-26' });
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await call('databrain_setup_start');
  await waitFor(stageIs('sources selected'), 'sources selected');
  await call('databrain_setup_run');
  await waitFor(stageIs('taxonomy pending'), 'taxonomy pending');
  const candidates = (await call('databrain_taxonomy_candidates')).split('\n').filter(line => line.startsWith('folder-')).map(line => line.split('\t'));
  await call('databrain_apply_taxonomy', { assignments: candidates.map(cols => ({ folder_id: cols[0], categories: [/notes/.test(cols[1]) ? 'notes' : 'docs'] })) });
  await waitFor(stageIs('relationships pending'), 'relationships pending');
  await call('databrain_build_relationships');
  await waitFor(stageIs('verification pending'), 'verification pending');
  assert.equal((await indexRows()).length, 5);

  const baseline = await call('databrain_search', { query: 'zephyrquill' });
  assert(baseline.includes('codename.md') && !baseline.includes('Freshness:'), 'no note when nothing changed');

  // added file: the answer comes back at once from the current index, with the count, then it is found
  await sleep(700);
  await fs.writeFile(path.join(notes, 'added.md'), '# Added\nThe quillfern prototype uses a brass hinge.\n');
  const first = await call('databrain_search', { query: 'quillfern' });
  assert(!first.includes('added.md'), 'the first answer comes from the previous index');
  assert(/Freshness: 1 file changed since the last index \(1 added\)\. Refreshing in the background/.test(first), `expected a change note, got: ${first}`);
  // an edit made WHILE that refresh runs must not be lost: it is flagged and picked up by the next pass
  await fs.writeFile(path.join(notes, 'added.md'), '# Added\nThe quillfern prototype uses a brass hinge. Later edit: lateword.\n');
  await waitFor(idle, 'refresh idle');
  await waitFor(async () => (await call('databrain_search', { query: 'lateword' })).includes('added.md') || null, 'mid-refresh edit found by the next pass');
  await waitFor(idle, 'second refresh idle');
  assert((await call('databrain_setup_status')).includes('Stage: verification pending'), 'a silent refresh must keep the finished setup stage');
  const addedRow = (await indexRows()).find(line => line.includes('added.md'));
  assert.equal(addedRow.split('\t')[2], 'notes', 'a new file inherits its folder label');
  assert.equal((await indexRows()).filter(line => ['-', ''].includes(line.split('\t')[2])).length, 0, 'no unlabeled rows after a silent refresh');
  await fs.stat(path.join(dataHome, 'moc', 'relationships.tsv'));

  // changed file: the new words are found
  await sleep(700);
  await fs.writeFile(path.join(notes, 'added.md'), '# Added\nNow it mentions a marigold gasket.\n');
  const changed = await call('databrain_search', { query: 'marigold' });
  assert(/\(1 changed\)/.test(changed), `expected a changed note, got: ${changed}`);
  await waitFor(async () => (await call('databrain_search', { query: 'marigold' })).includes('added.md') || null, 'changed content found');
  await waitFor(idle, 'refresh idle after change');

  // deleted file: never returned, and its index row is pruned by the refresh
  await sleep(700);
  await fs.rm(path.join(notes, 'codename.md'));
  const rowsBefore = (await indexRows()).length;
  const deleted = await call('databrain_search', { query: 'zephyrquill' });
  assert(!deleted.includes('codename.md'), 'a deleted file must not be returned');
  assert(/\(1 deleted\)/.test(deleted), `expected a deleted note, got: ${deleted}`);
  await waitFor(async () => (await indexRows()).length < rowsBefore || null, 'deleted row pruned');
  await waitFor(async () => (await call('databrain_health')).includes('Source freshness: current.') || null, 'freshness current');
  assert(!(await indexRows()).some(line => line.includes('codename.md')), 'the deleted file row must be pruned from the index');
  const gone = await call('databrain_search', { query: 'zephyrquill' });
  assert(/no (approved-source )?matches/i.test(gone), `a deleted file must give no matches, got: ${gone}`);

  // the sources were only read
  assert.equal(await fs.readFile(path.join(notes, 'garden.md'), 'utf8'), '# Garden\nTomatoes need staking in June.\n');
  console.log('PASS: search answers from the current index, reports how many files changed, refreshes in the background, and finds added/changed files and drops deleted ones without touching the setup stage.');
} catch (error) {
  throw new Error(`${error.message}${stderr ? `\nMCP stderr: ${stderr.slice(0, 1500)}` : ''}`);
} finally {
  server.kill('SIGTERM');
  await fs.rm(temp, { recursive: true, force: true });
}
