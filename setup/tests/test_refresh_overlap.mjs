// Part 22 (0.2.1): ChatGPT starts a new DataBrain process for every list it refreshes (six in 43 s on 2026-11-16). Each one saw the index stale, made its own refresh
// job, waited for the one lock and ended "already covered". A process that finds another one updating the index now makes NO job and waits for none, and says
// so as a fact; a job that only waits for the lock does not hold back the apps check. Fake HOME, invented files; the other process is a sqlite3 holding the lock.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const chatgpt = process.env.DATABRAIN_TEST_CLIENT === 'chatgpt';
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 240000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-overlap-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\noverlapplainmarker an ordinary note.\n');
const dataHome = path.join(home, 'DataBrain');
const child = spawn(process.execPath, [serverScript, ...(chatgpt ? ['--databrain-client', 'chatgpt'] : ['--databrain-source-roots', realDocs])], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '100' }, stdio: ['pipe', 'pipe', 'ignore'] });
const waiting = new Map(); let n = 0;
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const call = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const logLines = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
const jobStarts = lines => lines.filter(line => /\trefresh\t[0-9a-f]+\tjob-start\t/.test(line)).length;
let holder = null;
try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  if (chatgpt) { await call('databrain_setup_start', { folders: [realDocs] }); await call('databrain_setup_start', { folders: [realDocs], confirmed: true }); }
  else await call('databrain_setup_start');
  await until(async () => {
    const status = await call('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await call('databrain_privacy', { action: 'decide', keep: [] });
    return /Stage: (?:verification pending|ready)\./.test(status);
  }, 'setup reaches ready');
  await sleep(2500);

  // another DataBrain process is updating the index: it holds the lock
  const lockFile = path.join(dataHome, '.databrain', 'index-worker-lock.sqlite');
  await until(async () => fs.stat(lockFile).then(() => true, () => false), 'the lock file exists');
  holder = spawn('sqlite3', [lockFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  holder.stdin.write('BEGIN EXCLUSIVE;\nSELECT 1;\n');
  await sleep(800);
  await fs.writeFile(path.join(realDocs, 'late.md'), '# Late\noverlaplatemarker added while another process updates.\n');
  const before = jobStarts(await logLines());
  const answers = [];
  for (let i = 0; i < 4; i++) { await sleep(1200); answers.push(await call('databrain_search', { query: 'overlapplainmarker' })); }
  await sleep(1500);
  const during = await logLines();
  assert.equal(jobStarts(during) - before, 0, `no refresh job was made while another process holds the lock:\n${during.slice(-8).join('\n')}`);
  assert(answers.some(text => /another DataBrain connection is already updating the index, so these results come from the previous index/.test(text)), `the answer says so as a fact:\n${answers[0].slice(0, 400)}`);
  assert(!during.slice(-12).some(line => /\trefresh\t[0-9a-f]+\tlock\t[^\t]*\tbusy: waiting/.test(line)), 'no refresh job waits for the lock');

  // the lock is free again: the next question starts the refresh and the file is indexed
  holder.kill('SIGKILL'); holder = null;
  await sleep(500);
  await until(async () => { await call('databrain_search', { query: 'overlapplainmarker' }); return (await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8')).includes('/late.md\t'); }, 'the refresh runs once the lock is free');

  // the apps check is not held back by a job that only waits for the lock (source check: readAppsAtStart ignores jobs flagged waitingForLock)
  const source = await fs.readFile(serverScript, 'utf8');
  const start = source.slice(source.indexOf('async function readAppsAtStart'), source.indexOf('async function readAppsAtStart') + 900);
  assert(/job\.status === 'running' && !job\.waitingForLock/.test(start), 'the apps check ignores jobs that only wait for the lock');
  assert(/progressJob\.waitingForLock = true/.test(source) && /progressJob\.waitingForLock = false/.test(source), 'a job waiting for the lock is flagged, and cleared once it has it');
  console.log(`PASS: ${chatgpt ? 'ChatGPT' : 'Claude'} host: a process that finds the lock held by another makes no refresh job, says so as a fact, and refreshes once the lock is free; a job that only waits for the lock does not defer the apps check.`);
} finally { holder?.kill('SIGKILL'); child.kill('SIGKILL'); await sleep(500); await fs.rm(temp, { recursive: true, force: true }); }
