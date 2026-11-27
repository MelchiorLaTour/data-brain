// A DataBrain server that stays alive across an upgrade (ChatGPT's helper keeps servers for days) must not keep working with the code it loaded
// while the engine scripts on disk are the new ones. It remembers its build id (BUILDINFO.txt source_sha256). When the file on disk names another
// build: (1) an idle server leaves by itself; (2) a server in the middle of a job finishes that job, starts nothing new, answers every call with a
// plain "updated, ask again" message, and leaves only after the job ended; (3) a fresh server's diagnostics name an older server still running.
// The build swap is a rewrite of BUILDINFO.txt in a private engine folder (symlinks to the real engine, so nothing in the checkout changes).
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
const realEngine = process.env.DATABRAIN_ENGINE_DIR || path.resolve(path.dirname(serverScript), '../..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-stale-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, limit = 120000) => { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); };
const BUILD_A = 'a'.repeat(64); const BUILD_B = 'b'.repeat(64);
const engineDir = path.join(temp, 'engine');
await fs.mkdir(engineDir);
for (const name of await fs.readdir(realEngine)) if (name !== 'BUILDINFO.txt' && name !== '.git') await fs.symlink(path.join(realEngine, name), path.join(engineDir, name));
const setBuild = async id => fs.writeFile(path.join(engineDir, 'BUILDINFO.txt'), `source_sha256=${id}\nsource_tree=clean\n`);
await setBuild(BUILD_A);

const children = [];
async function startServer(label, extraEnv = {}) {
  const home = path.join(temp, `home-${label}`); const docs = path.join(home, 'Documents');
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(path.join(docs, 'plain.md'), '# Plain\nstalemarker an ordinary local note.\n');
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300', HOME: home, DATABRAIN_ENGINE_DIR: engineDir, DATABRAIN_TEST_STALE_CHECK_MS: '300', DATABRAIN_FRESHNESS_CHECK_MS: '3600000', DATABRAIN_TEST_NO_AUTO_CLOUD: '1', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  let exitCode = 'running'; child.on('exit', code => { exitCode = code; });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => /Stage: (?:verification pending|ready)\./.test(await tool('databrain_setup_status')), `${label}: setup reaches ready`);
  await until(async () => !/(refresh|index housekeeping|app check|relationship report|taxonomy|cloud fetch): running/.test(await tool('databrain_setup_status')), `${label}: idle`);
  await sleep(600);
  return { child, home, tool, exited: () => exitCode, log: async () => fs.readFile(path.join(home, 'DataBrain', '.databrain', 'stage-timing.log'), 'utf8').catch(() => '') };
}

try {
  // 1. idle server: leaves by itself after the swap; before the swap it works
  const idle = await startServer('idle');
  assert(/stalemarker/.test(await idle.tool('databrain_search', { query: 'stalemarker' })), 'the server works before the swap');
  assert.equal(idle.exited(), 'running');
  await setBuild(BUILD_B);
  await until(async () => idle.exited() !== 'running', 'an idle old server leaves after the build changed', 20000);
  assert.equal(idle.exited(), 0, 'and leaves cleanly');
  assert(/server-retired/.test(await idle.log()), 'the retirement is logged');

  // 2. busy server: a slow refresh is running when the build changes
  await setBuild(BUILD_A);
  const busy = await startServer('busy', { DATABRAIN_TEST_INDEX_DELAY_MS: '9000' });
  await fs.writeFile(path.join(busy.home, 'Documents', 'second.md'), '# Second\nsecondmarker a note added before the refresh.\n');
  const started = await busy.tool('databrain_refresh');
  await until(async () => /job-start/.test(await busy.log()) && /refresh/.test(await busy.log()), 'the refresh job started');
  const jobsBefore = (await busy.log()).split('\n').filter(l => /job-start/.test(l)).length;
  await setBuild(BUILD_B);
  await sleep(2500);
  assert.equal(busy.exited(), 'running', 'the server did not leave in the middle of the job');
  assert(!/job-end/.test((await busy.log()).split('\n').filter(l => /refresh/.test(l) && /job-end/.test(l)).join('')), 'the refresh was still running');
  const reply = await busy.tool('databrain_refresh');
  assert(/was updated while this connection was open/.test(reply), `a call after the swap gets the plain message:\n${reply}`);
  assert(/was updated while this connection was open/.test(await busy.tool('databrain_search', { query: 'stalemarker' })), 'so does a search');
  assert.equal((await busy.log()).split('\n').filter(l => /job-start/.test(l)).length, jobsBefore, 'no new job started after the swap');
  await until(async () => busy.exited() !== 'running', 'the server leaves after its job ended', 60000);
  assert.equal(busy.exited(), 0);
  const log = await busy.log();
  assert(/refresh[^\n]*job-end[^\n]*complete/.test(log), `the running job finished (was not cut off):\n${log}`);
  assert(log.indexOf('server-retired') < log.lastIndexOf('job-end'), 'the swap was seen while the job ran');

  // 3. diagnostics name an older server still running (a stand-in process whose command line is this server file, started before the install)
  await setBuild(BUILD_A);
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 90000)', await fs.realpath(serverScript)], { stdio: 'ignore' });
  children.push(decoy);
  await sleep(2200);
  await setBuild(BUILD_B);
  const fresh = await startServer('fresh');
  const diag = await fresh.tool('databrain_diagnostics');
  assert(new RegExp(`Older DataBrain servers still running from before the last update: 1 \\(pid ${decoy.pid}, started`).test(diag), `diagnostics name the old server:\n${diag}`);
  assert(!new RegExp(`pid ${fresh.child.pid}`).test(diag.split('Older DataBrain servers')[1] || ''), 'and not the fresh one');
  console.log('PASS: after a build change an idle old server leaves by itself, a busy one finishes its job, starts nothing new and answers every call with the plain message, and diagnostics name an older server still running.');
} finally {
  for (const child of children) child.kill('SIGKILL');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
