// A shared index lock reports active work without treating stale freshness or coverage as verified. The Claude app starts several DataBrain
// servers on one brain, and the update may be running in ANOTHER one, so the answer comes from the lock every update holds, not the asked
// process's own memory. Server A runs a slow update; server B checks health during it, then again after it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-healthupd-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents');
await fs.mkdir(docs, { recursive: true });
await fs.writeFile(path.join(docs, 'first.md'), '# First\nhealthupdmarker an ordinary note.\n');
await fs.writeFile(path.join(docs, 'second.md'), '# Second\nanother ordinary note.\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, limit = 150000) => { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); };
const dataHome = path.join(home, 'DataBrain');
const savedStage = async () => JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8')).stage;

function start(env = {}) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise((resolve, reject) => { const id = ++n; const timer = setTimeout(() => reject(new Error(`no answer to ${method} in 120 s (did the server exit?)`)), 120000); waiting.set(id, m => { clearTimeout(timer); resolve(m); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = ask('initialize', { protocolVersion: '2025-03-26' }).then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
  return { child, tool, ready };
}
const servers = [];
setTimeout(() => { console.error('FAIL: the test ran longer than 15 minutes'); process.exit(1); }, 15 * 60 * 1000).unref();
try {
  // set the brain up and let it settle, then stop it
  const setup = start({ DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }); servers.push(setup); await setup.ready;
  await setup.tool('databrain_setup_start');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'setup reaches ready');
  await sleep(2500); setup.child.kill('SIGKILL'); await sleep(1500);

  const quiet = await (async () => { const s = start(); servers.push(s); await s.ready; const text = await s.tool('databrain_health'); s.child.kill('SIGKILL'); await sleep(800); return text; })();
  assert(/Source freshness: current\./.test(quiet) && !/issue/.test(quiet), `before any change, health is plain:\n${quiet}`);

  // A runs a slow update; B is a different process with no update of its own
  const A = start({ DATABRAIN_TEST_UPDATE_DELAY_MS: '9000', DATABRAIN_TEST_FRESH_CAP_MS: '1000', DATABRAIN_FRESHNESS_CHECK_MS: '100' }); servers.push(A); await A.ready;
  const B = start({ DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }); servers.push(B); await B.ready;
  await sleep(1500);
  await fs.writeFile(path.join(docs, 'third.md'), '# Third\nhealthupdnewmarker written while the update runs.\n');
  const searched = await A.tool('databrain_search', { query: 'healthupdnewmarker' });   // starts A's update; the call returns at its short cap
  assert(/New changes are being added/.test(searched), `A's update is running in the background:\n${searched.slice(0, 300)}`);
  const during = await B.tool('databrain_health');
  assert(/Source freshness: stale: 1 added/.test(during), `B keeps freshness stale while A is updating:\n${during}`);
  assert(/Another DataBrain job holds the shared index lock; source updates are not confirmed\./.test(during), `B detects A's shared lock without claiming its own checks are current:\n${during}`);
  assert(/The check reported an issue/.test(during), `stale freshness remains an issue until it is rechecked:\n${during}`);

  // when the update ends, the same call is plain again
  await until(async () => /Source freshness: current\./.test(await B.tool('databrain_health')), 'the update finishes and health is current', 60000);
  const after = await B.tool('databrain_health');
  assert(!/issue|update is running|being updated/.test(after), `afterwards no update wording and no issue:\n${after}`);
  assert((await B.tool('databrain_search', { query: 'healthupdnewmarker' })).includes('third.md'), 'and the new note is searchable');
  // The probe holds the lock's shared side for a few ms. A user's change (here: saving a note) made in another process at that moment must
  // still succeed: the mutation lock retries before it says another job holds the lock.
  const selection = path.join(temp, 'selection.txt'); await fs.writeFile(selection, `${docs}\n`);
  const writer = start({ DATABRAIN_TEST_PARENT: home, DATABRAIN_TEST_HOME: dataHome, DATABRAIN_TEST_SOURCE_ROOTS: JSON.stringify([docs]), DATABRAIN_TEST_SELECTION_FILE: selection, DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }); servers.push(writer); await writer.ready;
  let probing = true; let probes = 0;
  const prober = (async () => { while (probing) { await B.tool('databrain_health'); probes++; } })();
  const saved = [];
  for (let i = 0; i < 12; i++) {
    const title = `Probe note ${i}`;
    const started = await writer.tool('databrain_capture', { title, body: `written while another process probes health ${i}`, keywords: ['probe', `note${i}`], folder: docs });
    assert(/Save job: /.test(started), `the save started:\n${started.slice(0, 300)}`);
    let line = '';
    await until(async () => { line = (await writer.tool('databrain_setup_status')).split('\n').find(l => l.includes('note write:') && l.includes(title)) || ''; return /complete|failed/.test(line); }, `save ${i} ends`, 60000);
    saved.push(line);
  }
  probing = false; await prober;
  const failed = saved.filter(line => !/note write: complete/.test(line));
  assert(failed.length === 0, `${failed.length} of ${saved.length} saves failed while ${probes} health probes ran:\n${failed[0]}`);
  console.log(`(${saved.length} saves completed while ${probes} health probes ran)`);
  console.log('PASS: health keeps freshness stale and reports the shared lock as unconfirmed while another server refreshes; after completion it is current, the new note is searchable, and writes still succeed during probes.');
} finally {
  for (const s of servers) s.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
