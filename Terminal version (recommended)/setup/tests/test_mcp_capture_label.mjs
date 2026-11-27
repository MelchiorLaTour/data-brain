// A captured note has no theme of its own. 0.1.46 left its index row unlabeled, so after the relationship report a ready brain
// dropped to "verification pending" and databrain_verify_install said FAIL ("1 record with no label"), with no way back by itself.
// Checks (invented data, fake HOME): the captured row carries its folder group's label, the brain is back to ready with no user action,
// verify_install has no FAIL; and a brain ALREADY stranded that way (unlabeled row, verification pending) recovers by itself.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-capture-label-')));
const notes = path.join(temp, 'sources', 'notes');
const parent = path.join(temp, 'parent');
const dataHome = path.join(parent, 'DataBrain');
await Promise.all([notes, parent, path.join(temp, 'home')].map(dir => fs.mkdir(dir, { recursive: true })));
await fs.writeFile(path.join(notes, 'garden.md'), '# Garden\nTomatoes need staking in June.\n');
await fs.writeFile(path.join(notes, 'bike.md'), '# Bike\nOil the chain every month.\n');
await fs.writeFile(path.join(notes, 'boat.md'), '# Boat\nCheck the hull before spring.\n');

function startServer() {
  const server = spawn(process.execPath, [serverScript, '--databrain-parent', parent, '--databrain-source-roots', notes],
    { env: { ...process.env, HOME: path.join(temp, 'home') }, stdio: ['pipe', 'pipe', 'pipe'] });
  server.stderr.resume();
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
  const stop = async () => { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve)); };
  const ready = async () => { await rpc('initialize', { protocolVersion: '2025-03-26' }); server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); };
  return { call, stop, ready };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, limitMs = 120000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    assert(Date.now() - start < limitMs, `timed out waiting for ${label}`);
    await sleep(300);
  }
}
const statePath = path.join(dataHome, '.databrain', 'desktop-state.json');
const stage = async () => JSON.parse(await fs.readFile(statePath, 'utf8')).stage;
const indexLines = async () => (await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8')).split('\n').filter(line => line && !line.startsWith('#'));
const rowFor = async name => (await indexLines()).map(line => line.split('\t')).find(cols => cols[0].includes(name));
const noFail = text => assert(!/^FAIL:/m.test(text), `verify_install must have no FAIL:\n${text}`);

try {
  const first = startServer();
  try {
    await first.ready();
    await first.call('databrain_setup_start');
    await waitFor(async () => (await first.call('databrain_setup_status')).includes('DataBrain is ready') || null, 'the first setup to reach ready');
    const gardenLabel = (await rowFor('garden.md'))[2];
    assert(gardenLabel && gardenLabel !== '-', `sanity: normal rows are labelled (${gardenLabel})`);

    const saved = await first.call('databrain_capture', { title: 'Climbing harness idea', body: 'Buy a climbing harness for the wall.', keywords: ['climbing', 'harness'], folder: notes });
    assert(/Save job/.test(saved), saved);
    await waitFor(async () => await rowFor('Climbing harness idea') || null, 'the captured row in the index');
    // wait for the save job, the relationship report and the automatic promotion
    await waitFor(async () => (await first.call('databrain_setup_status')).includes('DataBrain is ready') && (await stage()) === 'ready' ? true : null, 'the brain to be ready again after the capture');
    const row = await rowFor('Climbing harness idea');
    assert.equal(row[2], gardenLabel, `the captured row must carry its folder's label, got "${row[2]}"`);
    noFail(await first.call('databrain_verify_install'));
    assert.equal(await stage(), 'ready');
  } finally { await first.stop(); }

  // A brain already stranded by 0.1.46: unlabeled captured row and verification pending. It must recover with no user action.
  const indexPath = path.join(dataHome, 'moc', 'index.tsv');
  const text = await fs.readFile(indexPath, 'utf8');
  await fs.writeFile(indexPath, text.split('\n').map(line => line.includes('Climbing harness idea') ? line.split('\t').map((col, i) => i === 2 ? '-' : col).join('\t') : line).join('\n'));
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  await fs.writeFile(statePath, `${JSON.stringify({ ...state, stage: 'verification pending' }, null, 2)}\n`);
  assert.equal((await rowFor('Climbing harness idea'))[2], '-', 'sanity: the stranded row is unlabeled');
  const upgraded = startServer();
  try {
    await upgraded.ready();
    await upgraded.call('databrain_setup_status');   // any call: the maintenance pass does the rest
    await waitFor(async () => (await stage()) === 'ready' ? true : null, 'the stranded brain to get back to ready');
    assert.notEqual((await rowFor('Climbing harness idea'))[2], '-', 'the stranded row must be labelled again');
    noFail(await upgraded.call('databrain_verify_install'));
    assert((await upgraded.call('databrain_setup_status')).includes('DataBrain is ready'));
  } finally { await upgraded.stop(); }
  console.log('PASS: a captured note takes its folder group\'s label, the brain is back to ready by itself and verify_install has no FAIL; a brain already stranded at verification pending with an unlabeled row recovers by itself.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
