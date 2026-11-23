// Part 28 A: index housekeeping (room pages + file inventory) never runs while DataBrain is being used.
//  Gate 1: a change is indexed and searches keep coming for longer than the idle time: the pass is "housekeeping-postponed" and does not run.
//  Gate 2: once no tool call has come for the idle time, the pass runs (and the pending mark is removed).
//  Gate 3: a search made while a pass runs is not slowed (median of 7 under a stated limit) and the pass's work runs at the lowest priority (nice 19).
// Fake HOME, invented files. A short idle time is a test setting (DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS); the product default is 5 minutes.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS; delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const chatgpt = process.env.DATABRAIN_TEST_CLIENT === 'chatgpt';
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const IDLE_MS = 8000;
const SEARCH_MEDIAN_LIMIT_MS = 2000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 240000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-hkidle-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nidleplainmarker an ordinary note.\n');
const dataHome = path.join(home, 'DataBrain'); const stateDir = path.join(dataHome, '.databrain');
let server = null;
function start() {
  const child = spawn(process.execPath, [serverScript, ...(chatgpt ? ['--databrain-client', 'chatgpt'] : ['--databrain-source-roots', realDocs])], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_LOCK_POLL_MS: '200', DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: String(IDLE_MS), DATABRAIN_TEST_HOUSEKEEPING_HOLD_MS: '9000' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return { child, call: async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '', init: async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); } };
}
const logLines = async () => (await fs.readFile(path.join(stateDir, 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
const passes = lines => lines.filter(line => /\tindex housekeeping\t[0-9a-f]+\tengine:inventory\.sh\t/.test(line)).length;
const postponed = lines => lines.filter(line => /\tindex housekeeping\t[0-9a-f]+\thousekeeping-postponed\t/.test(line)).length;
const exists = async file => fs.access(file).then(() => true, () => false);
const pendingFile = path.join(stateDir, 'housekeeping-pending');
// every DataBrain call keeps the brain "busy"; this calls search every 400 ms for `ms`
async function useFor(ms, query) { for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(400)) await server.call('databrain_search', { query }); }
try {
  server = start(); await server.init();
  if (chatgpt) { await server.call('databrain_setup_start', { folders: [realDocs] }); await server.call('databrain_setup_start', { folders: [realDocs], confirmed: true }); }
  else await server.call('databrain_setup_start');
  await until(async () => {
    const status = await server.call('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await server.call('databrain_privacy', { action: 'decide', keep: [] });
    return /Stage: (?:verification pending|ready)\./.test(status);
  }, 'setup reaches ready');
  // whatever housekeeping the setup asked for finishes first (nothing is called for a while)
  await sleep(IDLE_MS + 14000);
  await until(async () => !(await exists(pendingFile)), 'setup housekeeping finished');
  let lines = await logLines(); const basePasses = passes(lines); const basePostponed = postponed(lines);

  // Gate 1: a change, then searches for 2 x the idle time: postponed, not run
  await fs.writeFile(path.join(realDocs, 'one.md'), '# One\nidleonemarker added while the brain is in use.\n');
  const t0 = Date.now();
  await until(async () => /idleonemarker/.test(await server.call('databrain_search', { query: 'idleonemarker' })), 'the new note is searchable');
  await until(async () => postponed(await logLines()) > basePostponed, 'the pass is logged as postponed', 30000);
  await useFor(IDLE_MS * 2, 'idleonemarker');
  lines = await logLines();
  assert.equal(passes(lines) - basePasses, 0, `no housekeeping pass ran while searches kept coming (${Math.round((Date.now() - t0) / 1000)} s, idle time ${IDLE_MS / 1000} s):\n${lines.slice(-10).join('\n')}`);
  assert(await exists(pendingFile), 'the postponed pass is remembered (pending mark present)');
  console.log('gate 1: searches keep coming for 2 x the idle time, pass postponed, not run: PASS');

  // Gate 2: stop calling; the pass runs after the idle time and the mark goes. The held pass (test hold, 9 s) is where gate 3 measures.
  const quietFrom = Date.now();
  let seenNice = null; const ranBy = []; let lat = [];
  await until(async () => {
    const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,ni=,command=']).stdout.toString().split('\n');
    const busy = ps.map(row => row.trim().split(/\s+/)).find(f => Number(f[1]) === server.child.pid && /\/usr\/bin\/yes$|\byes$/.test(f.slice(3).join(' ')));
    if (busy && seenNice === null) {
      seenNice = Number(busy[2]); ranBy.push(Date.now() - quietFrom);
      for (let i = 0; i < 7; i += 1) { const s0 = Date.now(); await server.call('databrain_search', { query: 'idleonemarker' }); lat.push(Date.now() - s0); }
    }
    return passes(await logLines()) - basePasses >= 1 && seenNice !== null;
  }, 'the pass ran after the idle time and was caught running', 120000);
  assert(ranBy[0] >= IDLE_MS - 2500, `the pass began only after the idle time (began ${ranBy[0]} ms after the last call, idle time ${IDLE_MS} ms)`);
  console.log(`gate 2: the pass began ${Math.round(ranBy[0] / 1000)} s after the last call (idle time ${IDLE_MS / 1000} s): PASS`);

  // Gate 3
  lat.sort((a, b) => a - b); const median = lat[3];
  assert(seenNice >= 19, `the pass work runs at nice 19 or lower priority (saw nice ${seenNice})`);
  assert(median <= SEARCH_MEDIAN_LIMIT_MS, `a search during a running pass: median ${median} ms of [${lat.join(', ')}], limit ${SEARCH_MEDIAN_LIMIT_MS} ms`);
  console.log(`gate 3: search during the pass: median ${median} ms (limit ${SEARCH_MEDIAN_LIMIT_MS} ms), pass work at nice ${seenNice}: PASS`);
  await until(async () => !(await exists(pendingFile)), 'the pending mark is removed after the pass', 60000);
  console.log('housekeeping idle: PASS');
} finally { server?.child.kill(); await fs.rm(temp, { recursive: true, force: true }); }
