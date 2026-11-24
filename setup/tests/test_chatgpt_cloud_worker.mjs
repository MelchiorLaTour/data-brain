// Part 35 (ChatGPT host): the iCloud download runs in a detached background worker that survives the server, resumes without redoing finished work,
// restarts by itself, holds the Mac awake and reports its progress. Fake HOME, invented files; "online-only" is SIMULATED with NB_TEST_DATALESS_LIST,
// a fake brctl puts an evicted file back on that list, and DATABRAIN_TEST_DOWNLOAD_LOG records every download and every eviction in order.
//   Gate 1  kill the SERVER mid-batch: the worker keeps going and completes; each file is downloaded once; a caffeinate call names the worker pid;
//           a NEW server shows "Cloud fetch: N of M" from the worker's progress; the stage log has one job-start and one "complete" job-end.
//   Gate 2  kill the WORKER mid-batch and every server; a NEW server relaunches by itself and finishes; files of finished batches are not downloaded
//           again; the cut-off batch is put back online-only (before anything else), then redone; the dead job gets an "abandoned" job-end.
//   Gate 3  two workers at once: one runs, the other leaves on the lock; each file is downloaded once.
//   Gate 4  a worker cut off 5 times without progress is not restarted again (the loop guard); the status says it stopped.
// Usage: node test_chatgpt_cloud_worker.mjs [server.mjs]
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
const serverScript = path.resolve(process.argv[2] || process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs'));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-cloudworker-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 240000) { for (const t0 = Date.now(); !(await check()); await sleep(200)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

const WORDS = ['quokkaone', 'quokkatwo', 'quokkathree', 'quokkafour', 'quokkafive', 'quokkasix'];

// One fresh brain per scenario: 6 online-only iCloud notes, cut into 3 batches of 2.
async function brain(name, extraEnv = {}) {
  const home = path.join(temp, name, 'home');
  const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Notes');
  await fs.mkdir(icloud, { recursive: true });
  const dir = await fs.realpath(icloud);
  const files = WORDS.map(word => path.join(dir, `${word}.md`));
  for (const [i, file] of files.entries()) await fs.writeFile(file, `# Note ${i}\n${WORDS[i]} `.padEnd(2000, `${WORDS[i]} filler text. `) + '\n');
  await fs.writeFile(path.join(dir, 'local.md'), '# Local\nan ordinary local file that is already on this Mac.\n');
  const dataless = path.join(temp, name, 'dataless.txt');
  const events = path.join(temp, name, 'events.log');       // "download <file>" from the server, "evict <file>" from the fake brctl, in order
  const caffeinateLog = path.join(temp, name, 'caffeinate.log');
  const brctl = path.join(temp, name, 'brctl');
  const caffeinate = path.join(temp, name, 'caffeinate');
  await fs.writeFile(brctl, `#!/bin/bash\necho "evict $2" >> "${events}"\necho "$2" >> "${dataless}"\n`, { mode: 0o755 });
  await fs.writeFile(caffeinate, `#!/bin/bash\necho "$@" >> "${caffeinateLog}"\n`, { mode: 0o755 });
  await fs.writeFile(dataless, files.join('\n') + '\n');
  await fs.writeFile(events, '');
  const env = {
    HOME: home, NB_TEST_DATALESS_LIST: dataless, NB_BRCTL: brctl, DATABRAIN_TEST_DOWNLOAD_LOG: events, DATABRAIN_TEST_CAFFEINATE: caffeinate,
    DATABRAIN_TEST_FREE_KB: '100000000', DATABRAIN_TEST_CLOUD_BATCH_FILES: '2', DATABRAIN_TEST_CLOUD_BATCH_BYTES: '1000000', DATABRAIN_TEST_RETRY_BASE_MS: '300',
    DATABRAIN_TEST_CLIENT: 'chatgpt', ...extraEnv,
  };
  const dataHome = path.join(home, 'DataBrain');
  const read = file => fs.readFile(file, 'utf8').catch(() => '');
  return {
    name, home, dir, files, env, dataHome, events, caffeinateLog, dataless,
    statePath: path.join(dataHome, '.databrain', 'desktop-state.json'),
    state: async () => JSON.parse(await read(path.join(dataHome, '.databrain', 'desktop-state.json')) || '{}'),
    stageLog: () => read(path.join(dataHome, '.databrain', 'stage-timing.log')),
    indexText: () => read(path.join(dataHome, 'moc', 'index.tsv')),
    eventLines: async () => (await read(events)).split('\n').filter(Boolean),
    offline: async () => (await read(dataless)).split('\n').filter(Boolean).length,
    indexedQuokkas: async () => (await read(path.join(dataHome, 'moc', 'index.tsv'))).split('\n').filter(line => line.includes('quokka')).length,
  };
}

function server(b, extraEnv = {}) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', path.dirname(b.dir)], { env: { ...process.env, ...b.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} });
  child.stderr.on('data', () => {});
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, () => {}); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  child.stdin.on('error', () => {});
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, tool, ready, kill: signal => child.kill(signal) };
}
const settled = tool => async () => /Stage: (?:verification pending|ready)\./.test(await tool('databrain_setup_status'));

// Setup with the download switched off, so the test decides when it starts.
async function setUp(b) {
  const s = server(b, { DATABRAIN_TEST_NO_AUTO_CLOUD: '1' });
  await s.ready;
  await s.tool('databrain_setup_start');
  await until(settled(s.tool), `${b.name}: setup finished`, 600000);
  assert.equal((await b.indexText()).includes('quokka'), false, 'online-only files are not indexed by setup');
  s.kill('SIGTERM');
  await sleep(500);
}
const downloads = async b => (await b.eventLines()).filter(l => l.startsWith('download ')).map(l => l.slice(9));
const countBy = list => list.reduce((m, f) => m.set(f, (m.get(f) || 0) + 1), new Map());
const workerPid = async b => Number((await b.state()).cloudFetchJob?.ownerPid) || 0;
const workerSlow = { DATABRAIN_TEST_CLOUD_AFTER_DOWNLOAD_MS: '4000' };   // each batch waits 4 s between its downloads and its indexing: a place to cut it off

try {
  // ---------------- gate 1: the server dies, the worker lives ----------------
  {
    const b = await brain('g1', workerSlow);
    await setUp(b);
    const s1 = server(b, { DATABRAIN_TEST_NO_AUTO_CLOUD: '1' });
    await s1.ready;
    const started = await s1.tool('databrain_cloud_fetch');
    assert(/Downloading 6 online-only files/.test(started) && /3 batches/.test(started) && /background/.test(started), started);
    await until(async () => (await downloads(b)).length >= 2, 'the first batch is downloaded');
    await until(async () => workerPid(b), 'the worker recorded its pid');
    const worker = await workerPid(b);
    assert(worker > 1 && worker !== s1.child.pid && alive(worker), `a separate worker process is running (pid ${worker})`);
    s1.kill('SIGKILL');   // ChatGPT closes the connection: the server is gone
    await sleep(800);
    assert(!alive(s1.child.pid), 'the server is gone');
    assert(alive(worker), 'the worker outlived the server');
    // a new server sees the worker's progress
    const s2 = server(b, { DATABRAIN_TEST_NO_AUTO_CLOUD: '1' });
    await s2.ready;
    let seen = '';
    await until(async () => { seen = await s2.tool('databrain_setup_status'); return /Cloud fetch: \d+ of 6 files, batch \d of 3/.test(seen); }, 'a new server shows the worker progress', 60000);
    await until(async () => (await b.indexedQuokkas()) === 6 && (await b.offline()) === 6, 'all six indexed and back online-only', 240000);
    await until(async () => (await b.state()).cloudFetchJob?.status === 'complete', 'the job is complete');
    const counts = countBy(await downloads(b));
    for (const f of b.files) assert.equal(counts.get(f), 1, `${path.basename(f)} downloaded once, got ${counts.get(f)}`);
    const caffeinated = (await fs.readFile(b.caffeinateLog, 'utf8').catch(() => '')).trim().split('\n');
    assert(caffeinated.some(line => line === `-i -w ${worker}`), `the Mac is held awake for the worker: ${caffeinated.join(' | ')}`);
    await until(async () => !alive(worker), 'the worker has exited');
    const log = (await b.stageLog()).split('\n').filter(l => l.includes('\tcloud fetch\t'));
    assert.equal(log.filter(l => l.includes('\tjob-start\t')).length, 1, `one job-start:\n${log.join('\n')}`);
    assert.equal(log.filter(l => /\tjob-end\t.*complete/.test(l)).length, 1, `one job-end, complete:\n${log.join('\n')}`);
    s2.kill('SIGTERM');
  }

  // ---------------- gate 2: the worker is killed mid-batch, a new server restarts it ----------------
  {
    const b = await brain('g2', workerSlow);
    await setUp(b);
    const s1 = server(b, { DATABRAIN_TEST_NO_AUTO_CLOUD: '1' });
    await s1.ready;
    await s1.tool('databrain_cloud_fetch');
    // batch 1 is downloaded and indexed, batch 2 is downloaded and waiting to be indexed: cut it off there
    await until(async () => (await downloads(b)).length >= 4 && (await b.indexedQuokkas()) >= 2, 'batch 1 indexed and batch 2 downloaded');
    const worker = await workerPid(b);
    const before = await downloads(b);
    const batch1 = before.slice(0, 2); const batch2 = before.slice(2, 4);
    assert((await b.indexText()).includes(path.basename(batch1[0])) && (await b.indexText()).includes(path.basename(batch1[1])), 'batch 1 is indexed');
    process.kill(worker, 'SIGKILL');
    s1.kill('SIGKILL');
    await until(async () => !alive(worker), 'the worker is dead');
    assert.equal((await b.state()).cloudFetchJob?.status, 'running', 'the saved job still says running: nothing wrote an end');
    // a new server, auto-restart enabled
    const s2 = server(b);
    await s2.ready;
    await s2.tool('databrain_setup_status');
    await until(async () => (await b.indexedQuokkas()) === 6 && (await b.offline()) === 6, 'all six indexed and back online-only after the restart', 300000);
    await until(async () => (await b.state()).cloudFetchJob?.status === 'complete', 'the restarted job is complete');
    const events = await b.eventLines();
    const counts = countBy(await downloads(b));
    for (const f of batch1) assert.equal(counts.get(f), 1, `${path.basename(f)} (finished batch) is not downloaded again`);
    for (const f of b.files.filter(f => !batch1.includes(f))) assert((counts.get(f) || 0) >= 1, `${path.basename(f)} downloaded`);
    for (const f of batch2) {
      // The cut-off batch was left on the disk: the restart puts it back online-only before anything else. Whether it is then downloaded once more or
      // was already indexed from the disk by the new server's ordinary refresh depends on who got there first; both end the same way.
      const seq = events.filter(l => l.endsWith(f)).map(l => l.split(' ')[0]);
      assert.deepEqual(seq.slice(0, 2), ['download', 'evict'], `${path.basename(f)}: downloaded, then put back online-only by the restart, before any second download: ${seq.join(',')}`);
      assert((counts.get(f) || 0) <= 2, `${path.basename(f)} is downloaded at most twice`);
    }
    const stage = await b.stageLog();
    assert(/cloud fetch\t[0-9a-f]{8}\tjob-end\t[0-9]+ms\tabandoned/.test(stage), `the dead job got an end line:\n${stage}`);
    assert(/cloud-worker\t.*restart 1 of \d+/.test(stage), `the restart is logged:\n${stage}`);
    s2.kill('SIGTERM');
  }

  // ---------------- gate 3: two workers at once -> one ----------------
  {
    const b = await brain('g3', { DATABRAIN_TEST_CLOUD_AFTER_DOWNLOAD_MS: '1500' });
    await setUp(b);
    const run = id => spawn(process.execPath, [serverScript, '--databrain-client', 'chatgpt', '--databrain-run-cloud-worker', '--databrain-job-id', id], { env: { ...process.env, ...b.env }, stdio: 'ignore', detached: true });
    const a = run('00000000-0000-4000-8000-00000000000a'); const c = run('00000000-0000-4000-8000-00000000000b');
    a.unref(); c.unref();
    await until(async () => (await b.indexedQuokkas()) === 6 && (await b.offline()) === 6, 'all six indexed by one worker', 300000);
    await until(async () => !alive(a.pid) && !alive(c.pid), 'both processes have exited');
    const stage = await b.stageLog();
    assert.equal((stage.match(/cloud-worker\t[^\n]*pid=\d+ started/g) || []).length, 1, `exactly one worker started:\n${stage}`);
    assert.equal((stage.match(/another worker holds the lock/g) || []).length, 1, `the other left on the lock:\n${stage}`);
    const counts = countBy(await downloads(b));
    for (const f of b.files) assert.equal(counts.get(f), 1, `${path.basename(f)} downloaded once, got ${counts.get(f)}`);
  }

  // ---------------- gate 4: the loop guard ----------------
  {
    const b = await brain('g4');
    await setUp(b);
    // a fetch that was started and cut off five times already, with no progress and no live worker
    const state = await b.state();
    const now = new Date().toISOString();
    await fs.writeFile(b.statePath, JSON.stringify({ ...state, cloudFetchStarted: true, cloudFetchJob: { id: 'dead-job', status: 'running', ownerPid: 999999, restarts: 5, startedAt: now, updatedAt: now, nextRetryAt: now } }, null, 2));
    const s = server(b);
    await s.ready;
    let status = '';
    await until(async () => { status = await s.tool('databrain_setup_status'); return (await b.state()).cloudFetchJob?.status === 'stopped'; }, 'the guard stops the restarts', 60000);
    assert(/The cloud download stopped/.test(await s.tool('databrain_setup_status')), 'the status says it stopped');
    await sleep(1500);
    assert.equal((await downloads(b)).length, 0, 'nothing was downloaded after the guard stopped it');
    assert.equal((await b.stageLog()).split('\n').filter(l => /cloud-worker.*launching/.test(l)).length, 0, 'no worker was launched');
    s.kill('SIGTERM');
  }
  console.log('PASS: the ChatGPT cloud download is a detached worker: it outlives the server, resumes without re-downloading finished batches (the cut-off batch is put back online-only first), restarts by itself, one worker at a time, holds the Mac awake, stops after 5 cut-offs without progress, and a new server shows its progress.');
} finally {
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
