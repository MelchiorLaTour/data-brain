// Part 25 F: index housekeeping (room pages + file inventory, one pass 87-292 s on Mel's brain) is not repeated when another pass that STARTED after
// this one was requested has already finished. Two DataBrain processes share one brain; each indexes a change and asks for housekeeping while a third
// party holds the housekeeping lock; when it is released one pass runs and the other process logs the skip. Fake HOME, invented files.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS; delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const chatgpt = process.env.DATABRAIN_TEST_CLIENT === 'chatgpt';
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 240000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-hk-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nhkplainmarker an ordinary note.\n');
const dataHome = path.join(home, 'DataBrain');
const children = [];
function start() {
  const child = spawn(process.execPath, [serverScript, ...(chatgpt ? ['--databrain-client', 'chatgpt'] : ['--databrain-source-roots', realDocs])], { env: { ...process.env, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300', HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_LOCK_POLL_MS: '200' }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return { child, call: async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '', init: async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); } };
}
const logLines = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
const passes = lines => lines.filter(line => /\tindex housekeeping\t[0-9a-f]+\tengine:inventory\.sh\t/.test(line)).length;
const skips = lines => lines.filter(line => /\tindex housekeeping\t[0-9a-f]+\thousekeeping-skipped\t/.test(line)).length;
let holder = null;
try {
  const A = start(); await A.init();
  if (chatgpt) { await A.call('databrain_setup_start', { folders: [realDocs] }); await A.call('databrain_setup_start', { folders: [realDocs], confirmed: true }); }
  else await A.call('databrain_setup_start');
  await until(async () => {
    const status = await A.call('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await A.call('databrain_privacy', { action: 'decide', keep: [] });
    return /Stage: (?:verification pending|ready)\./.test(status);
  }, 'setup reaches ready');
  const B = start(); await B.init(); await B.call('databrain_setup_status');
  // the housekeeping lock is a sqlite file the server creates on first use; an empty file is a valid one, so it can be taken from outside now
  const lockFile = path.join(dataHome, '.databrain', 'housekeeping-lock.sqlite');
  await fs.writeFile(lockFile, '', { mode: 0o600, flag: 'a' });
  await sleep(6000);   // whatever housekeeping the setup itself asked for is done
  const base = passes(await logLines());
  holder = spawn('sqlite3', [lockFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  holder.stdin.write('BEGIN EXCLUSIVE;\nSELECT 1;\n');
  await sleep(800);
  // process A indexes one change, process B another; each asks for housekeeping and waits for the lock
  await fs.writeFile(path.join(realDocs, 'one.md'), '# One\nhkonemarker added for process A.\n');
  await until(async () => /hkonemarker/.test(await A.call('databrain_search', { query: 'hkonemarker' })), 'A indexes the first change');
  await sleep(1500);
  await fs.writeFile(path.join(realDocs, 'two.md'), '# Two\nhktwomarker added for process B.\n');
  await until(async () => /hktwomarker/.test(await B.call('databrain_search', { query: 'hktwomarker' })), 'B indexes the second change');
  await sleep(2500);
  assert.equal(passes(await logLines()) - base, 0, 'no housekeeping pass ran while the lock was held');
  holder.stdin.write('ROLLBACK;\n.quit\n'); holder = null;
  await until(async () => skips(await logLines()) >= 1 || passes(await logLines()) - base >= 2, 'the waiting passes finished', 180000);
  await sleep(3000);
  const lines = await logLines();
  assert.equal(passes(lines) - base, 1, `exactly one housekeeping pass ran for the two requests (ran ${passes(lines) - base}):\n${lines.slice(-14).join('\n')}`);
  assert.equal(skips(lines), 1, `the other process logged one skip:\n${lines.slice(-14).join('\n')}`);
  console.log('housekeeping: two requests, one pass, one logged skip: PASS');
} finally { holder?.kill(); for (const child of children) child.kill(); await fs.rm(temp, { recursive: true, force: true }); }
