// Part 29b: a job that is cut short when the app closes this DataBrain connection logs ONE job-end ("interrupted"), not a second "failed" one.
// Old: the killed housekeeping pass logged job-end twice with the same job id.
// (copy of the housekeeping-idle setup)
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
const IDLE_MS = 400;
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
  const child = spawn(process.execPath, [serverScript, ...(chatgpt ? ['--databrain-client', 'chatgpt'] : ['--databrain-source-roots', realDocs])], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_LOCK_POLL_MS: '200', DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: String(IDLE_MS), DATABRAIN_TEST_HOUSEKEEPING_HOLD_MS: '20000' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  await sleep(IDLE_MS + 14000);   // whatever housekeeping the setup asked for finishes first (as in test_housekeeping_idle)
  // a change is indexed, then no more calls: the pass it asked for starts after the short idle time
  await fs.writeFile(path.join(realDocs, 'one.md'), '# One\nidleonemarker added after setup.\n');
  await until(async () => /idleonemarker/.test(await server.call('databrain_search', { query: 'idleonemarker' })), 'the new note is searchable');
  // a held housekeeping pass is running: cut the server off in the middle of it
  await until(async () => spawnSync('ps', ['-axo', 'ppid=,command=']).stdout.toString().split('\n').some(row => row.trim().startsWith(`${server.child.pid} `) && /\byes$/.test(row.trim())), 'a housekeeping pass is running (held)', 60000);
  server.child.kill('SIGTERM');
  await sleep(3000);
  const rows = (await logLines()).map(line => line.split('\t'));
  const ends = new Map(); for (const f of rows) if (f[3] === 'job-end') ends.set(f[2], (ends.get(f[2]) || 0) + 1);
  const twice = [...ends].filter(([, count]) => count > 1);
  assert(rows.some(f => f[3] === 'job-end' && /^interrupted/.test(f[5] ?? '')), 'the cut-off job says it was interrupted');
  assert.equal(twice.length, 0, `one job-end per job id, but these ended more than once: ${JSON.stringify(twice)}`);
  console.log('job-end logged once per job, also for a job cut off by a closing connection: PASS');
} finally { server?.child.kill('SIGKILL'); await fs.rm(temp, { recursive: true, force: true }); }
