// Asking for a refresh while an update is already running (0.1.30 stress test, 2026-10-15): the answer was "Run initial setup before
// refreshing.", which is wrong and sends the user back to setup. It must say an update is running and to wait or check status.
//   server A runs a slow update; the refresh is asked in A itself and in B (a different process); a brain that was never set up still says
//   to run setup first.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-refreshupd-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents');
await fs.mkdir(docs, { recursive: true });
await fs.writeFile(path.join(docs, 'first.md'), '# First\nrefreshupdmarker an ordinary note.\n');
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
  const fresh = start({ DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }); servers.push(fresh); await fresh.ready;
  const never = await fresh.tool('databrain_refresh');
  assert(/Start setup first|Run initial setup/.test(never), `a brain that was never set up says to set up first:\n${never}`);
  for (let i = 0; i < 40; i++) await fs.writeFile(path.join(docs, `bulk${i}.md`), `# Bulk ${i}\nrefreshupdbulk ordinary note number ${i} with some words to index.\n`);
  const other = start({ DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }); servers.push(other); await other.ready;
  await fresh.tool('databrain_setup_start');
  // While the first indexing runs (stage "indexing"), a refresh asked in ANOTHER process must say an update is running, not "run initial setup".
  const duringFirst = [];
  for (const t0 = Date.now(); (await savedStage().catch(() => '')) !== 'ready' && Date.now() - t0 < 150000; await sleep(150)) {
    if ((await savedStage().catch(() => '')) === 'indexing') duringFirst.push(await other.tool('databrain_refresh'));
  }
  assert(duringFirst.length > 0, 'the first indexing was seen running (stage "indexing") at least once');
  for (const text of duringFirst) {
    assert(!/Run initial setup/.test(text), `during the first indexing a refresh must not say to run setup:\n${text}`);
    assert(/update is running/i.test(text) && /wait|status/i.test(text), `it says an update is running:\n${text}`);
  }
  other.child.kill('SIGKILL');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'setup reaches ready');
  await sleep(2500); fresh.child.kill('SIGKILL'); await sleep(1500);

  const A = start({ DATABRAIN_TEST_UPDATE_DELAY_MS: '9000', DATABRAIN_TEST_FRESH_CAP_MS: '1000', DATABRAIN_FRESHNESS_CHECK_MS: '100' }); servers.push(A); await A.ready;
  const B = start({ DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }); servers.push(B); await B.ready;
  await sleep(1500);
  await fs.writeFile(path.join(docs, 'third.md'), '# Third\nrefreshupdnewmarker written while the update runs.\n');
  const searched = await A.tool('databrain_search', { query: 'refreshupdnewmarker' });
  assert(/New changes are being added/.test(searched), `A's update is running in the background:\n${searched.slice(0, 300)}`);
  const inA = await A.tool('databrain_refresh');
  const inB = await B.tool('databrain_refresh');
  for (const [where, text] of [['the process that runs the update', inA], ['another process', inB]]) {
    assert(!/Run initial setup/.test(text), `${where}: a refresh during an update must not send the user back to setup:\n${text}`);
    assert(/update is (already )?running/i.test(text) && /wait|status/i.test(text), `${where}: it says an update is running and to wait or check status:\n${text}`);
  }
  console.log('PASS: a refresh asked while an update runs (in the same process and in another) says an update is running and to wait or check status; a never-set-up brain still says to set up first.');
} finally {
  for (const s of servers) s.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
