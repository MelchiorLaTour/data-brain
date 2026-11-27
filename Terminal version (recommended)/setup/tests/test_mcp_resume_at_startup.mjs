// If Claude Desktop restarts while first-run indexing is going and nobody is chatting, the extension must pick the work up by itself
// a few seconds after it starts (no tool call), using the CURRENT folder list, and status must then say plainly that indexing was
// interrupted by the restart and resumed by itself, with the time.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-startup-')));
const home = path.join(temp, 'home');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 180000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const folders = {};
for (const name of ['A', 'B', 'C']) {
  folders[name] = path.join(home, `Folder${name}Unique`);
  await fs.mkdir(folders[name], { recursive: true });
  folders[name] = await fs.realpath(folders[name]);
  await fs.writeFile(path.join(folders[name], `note-${name.toLowerCase()}.md`), `# ${name}\nstartupmarker${name.toLowerCase()} text in folder ${name}.\n`);
}
const dataHome = path.join(home, 'DataBrain');
const timingLog = path.join(dataHome, '.databrain', 'stage-timing.log');
const savedState = async () => JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'));
const jobStarts = async () => (await fs.readFile(timingLog, 'utf8').catch(() => '')).split('\n').filter(line => /initial indexing\t[0-9a-f]+\tjob-start/.test(line)).length;

function start(roots, env) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = ask('initialize', { protocolVersion: '2025-03-26' }).then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
  return { child, tool, ready };
}

let second = null;
try {
  // first run with folders A and B dies mid-indexing (the app restarted)
  const first = start([folders.A, folders.B], { DATABRAIN_TEST_INDEX_DELAY_MS: '120000' });
  await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => /Running now: initial indexing/.test(await first.tool('databrain_setup_status')), 'first indexing running');
  first.child.kill('SIGKILL');
  assert.equal(await jobStarts(), 1, 'one job was started so far');
  assert.equal((await savedState()).stage, 'indexing');

  // the app starts the extension again, with the folders now A and C. NO tool call is made from here on until the checks below.
  second = start([folders.A, folders.C], { DATABRAIN_TEST_INDEX_DELAY_MS: '120000' });
  await second.ready;
  await until(async () => (await jobStarts()) === 2, 'the dead job resumed by itself with no tool call', 30000);
  const state = await savedState();
  assert(state.resumeNote?.at, `the resume must be recorded in the saved state: ${JSON.stringify(state.resumeNote)}`);
  assert.deepEqual([...state.roots].sort(), [folders.A, folders.C].sort(), `the resumed job must use the current folder list: ${state.roots}`);

  // now status carries the reason for the new job ID
  const status = await second.tool('databrain_setup_status');
  assert(/Indexing was interrupted when Claude restarted and resumed by itself at \d\d:\d\d \(now job [0-9a-f-]{36}\)\. Nothing needs to be done\./.test(status), `status must say the indexing was resumed after the restart:\n${status.slice(0, 1200)}`);
  assert(/Running now: initial indexing, job ID [0-9a-f-]{36}/.test(status));
  assert(/resumed by itself at \d\d:\d\d/.test(await second.tool('databrain_diagnostics')), 'diagnostics carries the same line');
  console.log('PASS: after an app restart mid-indexing the extension resumes the dead job by itself with no tool call, using the current folders, and status says it was interrupted by the restart and resumed at HH:MM.');
} finally {
  second?.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
