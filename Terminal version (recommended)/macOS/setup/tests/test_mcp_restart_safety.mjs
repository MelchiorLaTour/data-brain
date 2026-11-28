// Restart simulation. A reboot changes things DataBrain saved on disk: the disk number (st_dev) of every folder, process numbers (a saved PID
// may now be dead, or belong to an unrelated process, even one owned by root), lock folders left behind by a killed run, and the temp folder.
// Invented data, fake HOME. With NO user action the brain must read, verify (no FAIL), search and capture again, and a first-run indexing that
// the restart killed must resume. (Saved PIDs are only used by Codex mode; Desktop mode keeps its jobs in the running process, so Part 2 checks
// that garbage PIDs in the saved state change nothing.)
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-restart-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 150000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

function start(home, parent, roots, env = {}) {
  const child = spawn(process.execPath, [serverScript, '--databrain-parent', parent, '--databrain-source-roots', ...roots],
    { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise((resolve, reject) => {
    const id = ++n; const timer = setTimeout(() => reject(new Error(`timed out: ${method}`)), 40000);
    waiting.set(id, m => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = ask('initialize', { protocolVersion: '2025-03-26' }).then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
  const stop = async () => { child.kill('SIGTERM'); if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve)); };
  return { child, tool, ready, stop };
}
const noFail = text => assert(!/^FAIL:/m.test(text), `verify_install must have no FAIL:\n${text}`);
const kids = [];

try {
  // ---------- Part 1: a ready brain, then "reboot" ----------
  const home = path.join(temp, 'home1'); const parent = path.join(temp, 'parent1'); const notes = path.join(temp, 'src1', 'notes');
  await Promise.all([home, parent, notes].map(dir => fs.mkdir(dir, { recursive: true })));
  const root = await fs.realpath(notes);
  await fs.writeFile(path.join(root, 'garden.md'), '# Garden\nrestartmarkerzeta grows by the fence.\n');
  await fs.writeFile(path.join(root, 'bike.md'), '# Bike\nOil the chain every month.\n');
  await fs.writeFile(path.join(root, 'boat.md'), '# Boat\nCheck the hull before spring.\n');
  const dataHome = path.join(await fs.realpath(parent), 'DataBrain');
  const statePath = path.join(dataHome, '.databrain', 'desktop-state.json');
  const tsvPath = path.join(dataHome, '.databrain', 'root-identities.tsv');
  const moc = path.join(dataHome, 'moc');
  const first = start(home, parent, [root]);
  await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => (await first.tool('databrain_setup_status')).includes('DataBrain is ready'), 'the first setup to be ready');
  await first.stop();

  // what a reboot does
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.rootIdentities = state.rootIdentities.map(entry => ({ ...entry, dev: entry.dev + 2 }));
  state.indexJob = { ...(state.indexJob || {}), ownerPid: 1, enginePid: 1, engineScript: 'extract.sh' };   // PID 1 is alive and owned by root: kill(pid, 0) answers EPERM
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await fs.writeFile(tsvPath, state.rootIdentities.map(({ path: p, dev, ino }) => `${p}\t${dev}:${ino}`).join('\n') + '\n');
  const baselinePath = path.join(moc, 'source-freshness.tsv');
  const baseline = await fs.readFile(baselinePath, 'utf8');
  await fs.writeFile(baselinePath, baseline.split('\n').map((line, i) => {
    if (i === 0 || !line) return line;
    const [file, dev, ...rest] = line.split('\t');
    return /^\d+$/.test(dev) ? [file, String(Number(dev) + 2), ...rest].join('\t') : line;
  }).join('\n'));
  const oldTime = new Date('2000-01-01T00:00:00Z');
  const sleeper = spawn('/bin/sleep', ['600'], { stdio: 'ignore' }); kids.push(sleeper);   // a live, unrelated process of the same user
  for (const lockName of ['index.tsv.lock', '.refresh.lock']) {
    const lock = path.join(moc, lockName);
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'pid'), `${sleeper.pid}\n`);   // its saved PID now names a live unrelated process
    await fs.utimes(lock, oldTime, oldTime);
  }
  const newTmp = path.join(temp, 'tmp-after-reboot'); await fs.mkdir(newTmp);   // the old TMPDIR is gone; the new one is empty
  const second = start(home, parent, [root], { TMPDIR: newTmp });
  try {
    await second.ready;
    const search = await second.tool('databrain_search', { query: 'restartmarkerzeta' });
    assert(!search.includes('changed identity'), `a renumbered disk must not lock reads out: ${search}`);
    assert(search.includes('garden.md'), `search must find the known word: ${search}`);
    noFail(await second.tool('databrain_verify_install'));
    const saved = await second.tool('databrain_capture', { title: 'After the restart', body: 'A note written after the restart.', keywords: ['afterrestart', 'note'], folder: root });
    assert(/Save job/.test(saved), saved);
    // the save job itself must succeed (a later refresh could index the file even if the save job failed on a stale lock)
    let saveStatus = '';
    await until(async () => /note write: (complete|failed)/.test(saveStatus = await second.tool('databrain_setup_status')), 'the save job to finish');
    assert(/note write: complete/.test(saveStatus), `the capture's save job must complete after the restart:\n${saveStatus}`);
    await until(async () => (await second.tool('databrain_search', { query: 'afterrestart' })).includes('After the restart'), 'the new capture to be searchable');
    await until(async () => JSON.parse(await fs.readFile(statePath, 'utf8')).stage === 'ready', 'the brain to be ready after the capture');
    assert((await second.tool('databrain_setup_status')).includes('DataBrain is ready'));
    noFail(await second.tool('databrain_verify_install'));
    const rows = (await fs.readFile(path.join(moc, 'index.tsv'), 'utf8')).split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('\t'));
    assert(rows.every(cols => cols[2] && cols[2] !== '-'), 'every row must carry a label');
  } finally { await second.stop(); }

  // ---------- Part 2: the restart kills a first-run indexing; its saved PID now names someone else's live process ----------
  const home2 = path.join(temp, 'home2'); const parent2 = path.join(temp, 'parent2'); const notes2 = path.join(temp, 'src2', 'notes');
  await Promise.all([home2, parent2, notes2].map(dir => fs.mkdir(dir, { recursive: true })));
  const root2 = await fs.realpath(notes2);
  await fs.writeFile(path.join(root2, 'one.md'), '# One\nresumemarkerone text.\n');
  const dataHome2 = path.join(await fs.realpath(parent2), 'DataBrain');
  const state2Path = path.join(dataHome2, '.databrain', 'desktop-state.json');
  const timingLog = path.join(dataHome2, '.databrain', 'stage-timing.log');
  const jobStarts = async () => (await fs.readFile(timingLog, 'utf8').catch(() => '')).split('\n').filter(line => /initial indexing\t[0-9a-f]+\tjob-start/.test(line)).length;
  const doomed = start(home2, parent2, [root2], { DATABRAIN_TEST_INDEX_DELAY_MS: '120000' });
  await doomed.ready;
  await doomed.tool('databrain_setup_start');
  await until(async () => /Running now: initial indexing/.test(await doomed.tool('databrain_setup_status')), 'first-run indexing running');
  doomed.child.kill('SIGKILL');
  await sleep(500);
  const state2 = JSON.parse(await fs.readFile(state2Path, 'utf8'));
  assert.equal(state2.stage, 'indexing');
  await fs.writeFile(state2Path, `${JSON.stringify({ ...state2, indexJob: { ...state2.indexJob, ownerPid: 1, enginePid: 1, engineScript: 'extract.sh' } }, null, 2)}\n`);
  assert.equal(await jobStarts(), 1);
  const resumed = start(home2, parent2, [root2], { DATABRAIN_TEST_INDEX_DELAY_MS: '120000' });
  try {
    await resumed.ready;
    await until(async () => (await jobStarts()) === 2, 'the killed indexing to resume although its saved PIDs now name a live process of another user', 40000);
  } finally { resumed.child.kill('SIGKILL'); }

  console.log('PASS: after a simulated reboot (every saved disk number renumbered, saved PIDs naming a live root process and a live unrelated process, stale lock folders from before the boot, a new empty TMPDIR) the brain reads, searches, verifies with no FAIL and captures with no user action, and an indexing killed by the restart resumes.');
} finally {
  for (const kid of kids) kid.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
