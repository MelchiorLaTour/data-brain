// Part 13 (0.2.1), item 2: on a real Mac the on-use freshness check froze the server's own loop for 13 s (loop-stalled in the log), so a search took 8 to 18 s
// and health 42 s. The blocking part was a stat process run with spawnSync for every 200 files (cloud-only check) over ~5,600 files in 6 folders.
// Here: 6 folders, ~6,000 files (a few hundred indexed, the rest new), the stat program made slow on purpose (0.4 s per call, like a synced folder), and no
// stall over 250 ms is allowed while the check runs; a search must answer in under 3 s meanwhile. Invented data, fake HOME.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-loopstall-')));
const home = path.join(temp, 'home'); await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const ROOTS = 6; const INDEXED_PER_ROOT = process.env.DATABRAIN_TEST_CLIENT === 'chatgpt' ? 20 : 50; const EXTRA_TOTAL = 6000 - ROOTS * INDEXED_PER_ROOT;
const roots = [];
for (let r = 0; r < ROOTS; r++) {
  const root = path.join(temp, `Folder${r}`); await fs.mkdir(root, { recursive: true }); roots.push(await fs.realpath(root));
  for (let k = 0; k < INDEXED_PER_ROOT; k++) await fs.writeFile(path.join(roots[r], `note-${k}.md`), `# Note ${r}-${k}\nloopstallmarker${r}x${k} an invented note about nothing real.\n`);
}
const slowStat = path.join(temp, 'slow-stat.sh');
await fs.writeFile(slowStat, '#!/bin/bash\nsleep 0.4\nexec /usr/bin/stat "$@"\n', { mode: 0o755 });
const dataHome = path.join(home, 'DataBrain');
const env = { ...process.env, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300', HOME: home, DATABRAIN_TEST_LOCK_POLL_MS: '200' };
let n = 0;
function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, tool, ready };
}
const timing = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => l.split('\t'));
const servers = [];
try {
  const first = startServer(); servers.push(first); await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => /Stage: (?:verification pending|ready)\./.test(await first.tool('databrain_setup_status')), 'setup reaches ready', 900000);
  await until(async () => { const rows = await timing(); return ['index housekeeping', 'refresh', 'app check', 'note write'].every(kind => rows.filter(f => f[1] === kind && f[3] === 'job-start').length === rows.filter(f => f[1] === kind && f[3] === 'job-end').length); }, 'jobs settle', 300000);
  first.child.kill('SIGKILL'); await sleep(1000);

  // the files that arrive later, ~5,700 of them spread over the 6 folders, and every indexed file touched (ctime moves, bytes and mtime kept)
  for (let start = 0; start < EXTRA_TOTAL; start += 200) {
    await Promise.all(Array.from({ length: Math.min(200, EXTRA_TOTAL - start) }, (_, k) => { const i = start + k; return fs.writeFile(path.join(roots[i % ROOTS], `extra-${i}.md`), `# Extra ${i}\nloopstallextra${i}\n`); }));
  }
  for (const root of roots) for (let k = 0; k < INDEXED_PER_ROOT; k++) { const file = path.join(root, `note-${k}.md`); await fs.chmod(file, 0o600); }
  const stallsBefore = (await timing()).filter(f => f[3] === 'loop-stalled').length;
  const checksBefore = (await timing()).filter(f => f[3] === 'freshness-check').length;

  const s = startServer({ DATABRAIN_TEST_STAT_BIN: slowStat, DATABRAIN_TEST_LAG_LOG_MS: '250' }); servers.push(s); await s.ready;
  const t0 = Date.now();
  const answer = await s.tool('databrain_search', { query: 'loopstallmarker3x7' });
  const ms = Date.now() - t0;
  assert(/loopstallmarker3x7/.test(answer), 'the answer is there');
  assert(ms < 3000, `a search answers in under 3 s while the freshness check runs: ${ms} ms`);
  await until(async () => (await timing()).filter(f => f[3] === 'freshness-check').length > checksBefore, 'the freshness check finishes', 180000);
  await sleep(1500);
  const stalls = (await timing()).filter(f => f[3] === 'loop-stalled').slice(stallsBefore);
  assert.equal(stalls.length, 0, `the server's loop never stands still for 250 ms or more during the check; log:\n${stalls.map(f => f.slice(1).join(' ')).join('\n')}`);
  console.log(`  ${ROOTS} folders, ~6,000 files, slow stat: search ${ms} ms, no stall over 250 ms`);
  console.log('PASS: the on-use freshness check does not stop the server\'s loop (no loop-stalled line at 250 ms) and a search answers in under 3 s meanwhile.');
} finally {
  for (const server of servers) server.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
