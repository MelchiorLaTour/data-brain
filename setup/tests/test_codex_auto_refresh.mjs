// Codex mode must refresh approved files on search, preserve setup readiness, and survive host exit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const launcher = process.env.DATABRAIN_TEST_LAUNCHER;
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-codex-auto-refresh-')));
const home = path.join(temp, 'home');
const source = path.join(home, 'Documents', 'Project notes');
const desktop = path.join(home, 'Desktop');
const destination = path.join(desktop, 'DataBrain');
const selection = path.join(temp, 'selection.fixture');
const statePath = path.join(destination, '.databrain', 'desktop-state.json');
await Promise.all([source, desktop].map(dir => fs.mkdir(dir, { recursive: true })));
const packing = path.join(source, 'Packing.md');
const trip = path.join(source, 'Trip ideas.md');
await fs.writeFile(packing, '# Packing\nSee [[Trip ideas]] before leaving.\n');
await fs.writeFile(trip, '# Trip ideas\nPick Lisbon in May.\n');
await fs.writeFile(selection, JSON.stringify({ selections: { sources: [source], 'destination-parent': [desktop] }, approved: true }));

const env = {
  ...process.env,
  HOME: home,
  PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
  DATABRAIN_TEST_HOME: destination,
  DATABRAIN_TEST_SELECTION_FILE: selection,
  DATABRAIN_FRESHNESS_CHECK_MS: '1',
};

function start(label) {
  const server = spawn(launcher || process.execPath, launcher ? [] : [serverScript, '--databrain-client', 'codex'], {
    env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = new Map();
  let stderr = '';
  let id = 0;
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', value => { if (stderr.length < 10000) stderr += value; });
  readline.createInterface({ input: server.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id !== undefined) replies.get(message.id)?.(message);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`${label} ${method} timed out: ${stderr}`)), 30000);
    replies.set(requestId, message => {
      clearTimeout(timer);
      replies.delete(requestId);
      if (message.error) reject(new Error(`${label} ${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const result = await request('tools/call', { name, arguments: args });
    const text = result?.content?.find(block => block.type === 'text')?.text || '';
    assert(!result?.isError && !text.startsWith('DataBrain: '), `${label} ${name} failed: ${text}`);
    return text;
  };
  return { server, request, call };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function statusUntil(client, predicate, label, timeoutMs = 120000) {
  const started = Date.now();
  let status = '';
  while (Date.now() - started < timeoutMs) {
    status = await client.call('databrain_setup_status');
    if (predicate(status)) return status;
    if (/Background job [0-9a-f-]+: failed\s+—/i.test(status)) throw new Error(`${label} failed: ${status}`);
    await delay(100);
  }
  throw new Error(`${label} timed out: ${status}`);
}
async function waitForAutomaticRefresh(client) {
  return statusUntil(client, status => status.includes('Stage: verification pending.') && /Background job [0-9a-f-]+: complete/.test(status), 'automatic refresh');
}
async function indexText() { return fs.readFile(path.join(destination, 'moc', 'index.tsv'), 'utf8'); }
async function relationshipText() { return fs.readFile(path.join(destination, 'moc', 'relationships.tsv'), 'utf8'); }
async function searchUntil(client, query, expectedPath) {
  const started = Date.now();
  while (Date.now() - started < 90000) {
    const result = await client.call('databrain_search', { query });
    if (result.includes(expectedPath)) return result;
    await delay(100);
  }
  throw new Error(`automatic index did not return ${expectedPath}`);
}
async function shutDown(client) {
  if (client.server.exitCode !== null || client.server.signalCode !== null) return;
  client.server.kill('SIGTERM');
  await new Promise(resolve => client.server.once('exit', resolve));
}

let client;
try {
  client = start('Codex');
  await client.request('initialize', { protocolVersion: '2025-03-26' });
  client.server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await client.call('databrain_setup_start');
  await statusUntil(client, status => status.includes('Stage: taxonomy pending.') && /Background job [0-9a-f-]+: complete/.test(status), 'initial indexing');
  const candidates = (await client.call('databrain_taxonomy_candidates')).split('\n').filter(line => line.startsWith('folder-')).map(line => line.split('\t'));
  await client.call('databrain_apply_taxonomy', { assignments: candidates.map(([folder_id]) => ({ folder_id, categories: ['notes'] })) });
  await statusUntil(client, status => status.includes('Stage: verification pending.') && /taxonomy application[^\n]*complete/i.test(status), 'automatic relationship build', 15000);
  assert.match(await relationshipText(), /Packing\.md[^\n]*Trip\+ideas\.md/,
    'setup automatically builds explicit relationships after categories are applied');

  assert.match(await client.call('databrain_search', { query: 'Lisbon May' }), /Trip ideas\.md/);
  await delay(10);
  const added = path.join(source, 'Later.md');
  await fs.writeFile(added, '# Later\nThe violetkite meeting is in room 42.\n');
  await client.call('databrain_search', { query: 'violetkite room 42' });
  await waitForAutomaticRefresh(client);
  assert((await indexText()).split('\n').some(line => line.includes('Later.md') && line.includes('\tnotes\t')),
    'new files inherit the existing folder category');
  assert((await relationshipText()).includes('Later.md'), 'automatic refresh rebuilds relationships for new files');
  await searchUntil(client, 'violetkite room 42', 'Later.md');

  await delay(10);
  await fs.writeFile(added, '# Later\nThe violetkite meeting moved to room 84.\n');
  await client.call('databrain_search', { query: 'violetkite room 84' });
  await waitForAutomaticRefresh(client);
  await searchUntil(client, 'violetkite room 84', 'Later.md');

  await delay(10);
  const renamed = path.join(source, 'Rescheduled.md');
  await fs.rename(added, renamed);
  await client.call('databrain_search', { query: 'violetkite room 84' });
  await waitForAutomaticRefresh(client);
  assert(!(await indexText()).includes('Later.md'), 'rename removes the old index row');
  assert((await indexText()).includes('Rescheduled.md'), 'rename indexes the new path');
  assert(!(await relationshipText()).includes('Later.md'), 'rename removes the old relationship row');

  await delay(10);
  await fs.rm(renamed);
  await client.call('databrain_search', { query: 'violetkite room 84' });
  await waitForAutomaticRefresh(client);
  assert(!(await indexText()).includes('Rescheduled.md'), 'deletion prunes the source row');
  assert(!(await relationshipText()).includes('Rescheduled.md'), 'deletion prunes its relationship row');
  assert.match(await client.call('databrain_setup_status'), /Stage: verification pending\./,
    'automatic refresh preserves the completed setup stage');
  assert.equal(await fs.readFile(packing, 'utf8'), '# Packing\nSee [[Trip ideas]] before leaving.\n');
  assert.equal(await fs.readFile(trip, 'utf8'), '# Trip ideas\nPick Lisbon in May.\n');

  await delay(10);
  const afterRestart = path.join(source, 'After restart.md');
  await fs.writeFile(afterRestart, '# After restart\nThe copperfinch folder key is Q7.\n');
  await client.call('databrain_search', { query: 'copperfinch Q7' });
  await statusUntil(client, status => status.includes('Stage: indexing.') && /Background job [0-9a-f-]+: running/.test(status), 'refresh worker start');
  await shutDown(client);
  const completedAt = Date.now();
  let saved;
  while (Date.now() - completedAt < 120000) {
    saved = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (saved.stage === 'verification pending' && saved.indexJob?.status === 'complete') break;
    if (saved.indexJob?.status === 'failed') throw new Error(`detached refresh failed: ${saved.indexJob.message}`);
    await delay(100);
  }
  assert(saved?.stage === 'verification pending' && saved.indexJob?.status === 'complete',
    `automatic refresh must finish after the MCP host exits: ${JSON.stringify(saved?.indexJob)}`);
  client = start('Codex after restart');
  await client.request('initialize', { protocolVersion: '2025-03-26' });
  client.server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await statusUntil(client, status => status.includes('Stage: verification pending.'), 'host restart recovery');
  assert.match(await client.call('databrain_search', { query: 'copperfinch Q7' }), /After restart\.md/);
  process.stdout.write('PASS: Codex automatically indexes added, changed, renamed, and deleted approved files; inherits categories, rebuilds relationships, preserves readiness, and finishes a refresh after host exit and restart.\n');
} finally {
  if (client) await shutDown(client);
  await fs.rm(temp, { recursive: true, force: true });
}
