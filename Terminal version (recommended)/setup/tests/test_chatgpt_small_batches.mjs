// Part 38 (ChatGPT host): small download sub-batches, a real "indexed" count, a cancel that really stops, failures written as they happen.
// Fake HOME, invented files; "online-only" is SIMULATED (NB_TEST_DATALESS_LIST + fake brctl); "macOS takes a downloaded file back" is simulated by
// DATABRAIN_TEST_OFFLOAD_AFTER_DOWNLOADS=N: a file named offload-* (every time) or onceoff-* (the first time) is online-only again after N more downloads.
//   Gate 1  sub-batches of 2: every file reaches the index, nothing is online-only again at index time, `indexed` = rows
//   Gate 2  a file offloaded before indexing is tried once more in the next sub-batch (then it works), and when it is offloaded again it is listed as
//           "offloaded by macOS before indexing"; `indexed` counts real rows; the log says "N of M were online-only again at index time"
//   Gate 3  cancel with a reader that ignores SIGTERM and never returns: the worker stops within seconds, job-end is logged after it stopped
//   Gate 4  cloud-fetch-failures.tsv grows DURING the run
//   Gate 5  the worker logs the recovery eviction of an earlier, cut-off batch
// Usage: node test_chatgpt_small_batches.mjs [server.mjs]
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(process.argv[2] || process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs'));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-smallbatch-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 240000) { for (const t0 = Date.now(); !(await check()); await sleep(200)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const want = n => !process.env.GATES || process.env.GATES.split(',').includes(String(n));   // GATES=3,4 runs only those gates (the mutant runs use it)
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function brain(name, specs, extraEnv = {}) {
  const home = path.join(temp, name, 'home');
  const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Notes');
  await fs.mkdir(icloud, { recursive: true });
  const dir = await fs.realpath(icloud);
  const files = [];
  for (const [i, spec] of specs.entries()) {
    const file = path.join(dir, spec.name);
    const src = path.join(temp, name, `${i}.src.txt`);
    await fs.writeFile(src, `${spec.marker} `.padEnd(spec.size, `${spec.marker} words about nothing. `));
    execFileSync('textutil', ['-convert', 'rtf', src, '-output', file]);
    files.push({ ...spec, file });
  }
  await fs.writeFile(path.join(dir, 'local.md'), '# Local\nan ordinary local file that is already on this Mac.\n');
  const dataless = path.join(temp, name, 'dataless.txt');
  const events = path.join(temp, name, 'events.log');
  const brctl = path.join(temp, name, 'brctl');
  await fs.writeFile(brctl, `#!/bin/bash\necho "evict $2" >> "${events}"\necho "$2" >> "${dataless}"\n`, { mode: 0o755 });
  await fs.writeFile(dataless, files.map(f => f.file).join('\n') + '\n');
  await fs.writeFile(events, '');
  const dataHome = path.join(home, 'DataBrain');
  const read = file => fs.readFile(file, 'utf8').catch(() => '');
  const env = {
    HOME: home, NB_TEST_DATALESS_LIST: dataless, NB_BRCTL: brctl, DATABRAIN_TEST_DOWNLOAD_LOG: events, DATABRAIN_TEST_FREE_KB: '100000000',
    DATABRAIN_TEST_CLIENT: 'chatgpt', DATABRAIN_TEST_NO_AUTO_CLOUD: '1', DATABRAIN_TEST_CLOUD_BATCH_FILES: '50', DATABRAIN_TEST_CLOUD_BATCH_BYTES: '100000000', ...extraEnv,
  };
  return {
    name, home, dir, files, env, dataHome, dataless, events, db: path.join(dataHome, '.databrain'),
    state: async () => JSON.parse(await read(path.join(dataHome, '.databrain', 'desktop-state.json')) || '{}'),
    indexText: () => read(path.join(dataHome, 'moc', 'index.tsv')),
    stageLog: () => read(path.join(dataHome, '.databrain', 'stage-timing.log')),
    failures: () => read(path.join(dataHome, '.databrain', 'cloud-fetch-failures.tsv')),
    progress: async () => JSON.parse(await read(path.join(dataHome, '.databrain', 'cloud-fetch-progress.json')) || '{}'),
    hasRow: async f => (await read(path.join(dataHome, 'moc', 'index.tsv'))).includes(path.basename(f.file, '.rtf')),
  };
}
function server(b) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', path.dirname(b.dir)], { env: { ...process.env, ...b.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} });
  child.stderr.on('data', () => {});
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, () => {}); });
  const tool = async (toolName, args = {}) => (await ask('tools/call', { name: toolName, arguments: args })).result?.content?.[0]?.text ?? '';
  child.stdin.on('error', () => {});
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, tool, ready, kill: signal => child.kill(signal) };
}
const settled = tool => async () => { const status = await tool('databrain_setup_status'); return /Stage: (?:verification pending|ready)\./.test(status) && !/: running — /.test(status); };
async function setUp(b) {
  const s = server(b);
  await s.ready;
  await s.tool('databrain_setup_start');
  await until(settled(s.tool), `${b.name}: setup finished`, 600000);
  return s;
}
const done = async b => (await b.state()).cloudFetchJob?.status === 'complete';
const sized = (names, top = 2600) => names.map((name, i) => ({ name: `${name}.rtf`, marker: `${name.replace(/[^a-z]/gi, '')}marker`, size: top - i * 100 }));

try {
  // ---------------- gate 1: sub-batches keep every file ----------------
  if (want(1)) {
    const b = await brain('g1', sized(['offload-a1', 'offload-a2', 'offload-a3', 'offload-a4', 'offload-a5', 'offload-a6']), { DATABRAIN_TEST_OFFLOAD_AFTER_DOWNLOADS: '3', DATABRAIN_TEST_CLOUD_SUB_FILES: '2' });
    const s = await setUp(b);
    await s.tool('databrain_cloud_fetch');
    await until(() => done(b), 'the fetch is complete', 300000);
    for (const f of b.files) assert(await b.hasRow(f), `${f.name} has an index row`);
    const log = (await b.stageLog()).split('\n').filter(l => /\tcloud-indexed\t/.test(l));
    assert(log.length >= 3, `one index step per sub-batch (${log.length}):\n${log.join('\n')}`);
    for (const l of log) assert(/\t0 of \d+ were online-only again at index time/.test(l), `nothing was lost: ${l}`);
    const progress = await b.progress();
    assert.equal(progress.indexed, 6, `indexed = real rows: ${JSON.stringify(progress)}`);
    assert.equal((await b.failures()).trim(), '', 'no failures');
    s.kill('SIGTERM');
  }

  // ---------------- gate 2: offloaded before indexing: retried once, then listed ----------------
  if (want(2)) {
    const b = await brain('g2', sized(['offload-always', 'ok-b', 'ok-x', 'onceoff-flaky', 'ok-c', 'ok-d']), { DATABRAIN_TEST_OFFLOAD_AFTER_DOWNLOADS: '1', DATABRAIN_TEST_CLOUD_SUB_FILES: '2' });
    const s = await setUp(b);
    await s.tool('databrain_cloud_fetch');
    await until(() => done(b), 'the fetch is complete', 300000);
    const byName = Object.fromEntries(b.files.map(f => [f.name, f]));
    for (const name of ['ok-b.rtf', 'ok-x.rtf', 'onceoff-flaky.rtf', 'ok-c.rtf', 'ok-d.rtf']) assert(await b.hasRow(byName[name]), `${name} has an index row (the flaky one after its second try)`);
    assert.equal(await b.hasRow(byName['offload-always.rtf']), false, 'the file that is taken back every time never gets a row');
    const progress = await b.progress();
    assert.equal(progress.indexed, 5, `indexed counts real rows (5 of 6): ${JSON.stringify(progress)}`);
    assert.equal(progress.failed, 1, `the one lost file is counted as failed: ${JSON.stringify(progress)}`);
    const failures = await b.failures();
    assert(/offload-always\.rtf\toffloaded by macOS before indexing/.test(failures), `it is listed with the reason:\n${failures}`);
    assert.equal(failures.trim().split('\n').length, 1, `only that file is listed:\n${failures}`);
    const lost = (await b.stageLog()).split('\n').filter(l => /\tcloud-indexed\t.*\t1 of 2 were online-only again at index time/.test(l));
    assert.equal(lost.length, 3, `the log says "1 of 2 were online-only again at index time" three times (first try of the always-lost file, its second try, the flaky file):\n${lost.join('\n')}`);
    const events = (await fs.readFile(b.events, 'utf8')).split('\n').filter(l => l.startsWith('download ') && l.includes('offload-always'));
    assert.equal(events.length, 2, `the always-lost file was downloaded twice, not more: ${events.length}`);
    s.kill('SIGTERM');
  }

  // ---------------- gate 3: cancel with a reader that cannot be stopped politely ----------------
  if (want(3)) {
    const program = path.join(temp, 'stuckreader');
    await fs.writeFile(program, `#!/bin/bash\ncase "$1" in *hang*) exec perl -e '$SIG{TERM}="IGNORE"; sleep 600 # stuckreader' ;; *) exec /bin/cat "$1" ;; esac\n`, { mode: 0o755 });
    const b = await brain('g3', sized(['hang one', 'fine two']), { DATABRAIN_TEST_DOWNLOAD_PROGRAM: program, DATABRAIN_TEST_DOWNLOAD_TIMEOUT_MS: '600000' });
    const s = await setUp(b);
    await s.tool('databrain_cloud_fetch');
    await until(async () => Number((await b.state()).cloudFetchJob?.ownerPid) > 1, 'the worker recorded its pid');
    const st = await b.state();
    const worker = Number(st.cloudFetchJob.ownerPid);
    // the reader is the worker's own child, once the script has exec'd perl (the command line then names the stuck sleep)
    const readerOf = () => spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command=']).stdout.toString().split('\n').map(l => l.trim().split(/\s+/, 2).concat(l)).find(([pid, ppid, l]) => Number(ppid) === worker && /sleep 600 # stuckreader/.test(l));
    await until(async () => Boolean(readerOf()), 'the reader is blocked');
    const reader = Number(readerOf()[0]);
    await sleep(700);   // perl has installed its SIGTERM-ignoring handler
    const cancelledAt = Date.now();
    const reply = await s.tool('databrain_cancel_job', { job_id: st.cloudFetchJob.id });
    assert(/Cancellation requested/.test(reply), reply);
    await until(async () => !alive(worker), 'the worker has stopped', 8000);
    const took = Date.now() - cancelledAt;
    assert(took >= 1500 && took < 8000, `the worker stopped after the reader was killed (${took} ms)`);
    await until(async () => (await b.state()).cloudFetchJob?.status === 'cancelled', 'the job is cancelled');
    await until(async () => !alive(reader), 'the blocked reader is gone', 5000);
    const end = (await b.stageLog()).split('\n').find(l => /\tcloud fetch\t[0-9a-f]{8}\tjob-end\t/.test(l) && /cancelled/.test(l));
    assert(end, `a cancelled job-end is logged:\n${await b.stageLog()}`);
    assert(Date.parse(end.split('\t')[0]) >= cancelledAt + 1500, `job-end is logged after the reader was stopped, not at once: ${end}`);
    s.kill('SIGTERM');
  }

  // ---------------- gate 4: failures are written as they happen ----------------
  if (want(4)) {
    const program = path.join(temp, 'slowreader');
    await fs.writeFile(program, `#!/bin/bash\ncase "$1" in *hang*) exec sleep 600 ;; *) sleep 1.5; exec /bin/cat "$1" ;; esac\n`, { mode: 0o755 });
    const b = await brain('g4', sized(['hang first', 'slow b', 'slow c', 'slow d', 'slow e']), { DATABRAIN_TEST_DOWNLOAD_PROGRAM: program, DATABRAIN_TEST_DOWNLOAD_TIMEOUT_MS: '1200', DATABRAIN_TEST_CLOUD_SUB_FILES: '2' });
    const s = await setUp(b);
    await s.tool('databrain_cloud_fetch');
    await until(async () => /hang first\.rtf\ttimed out/.test(await b.failures()), 'the failure is listed while the run is going', 60000);
    assert.notEqual((await b.state()).cloudFetchJob?.status, 'complete', 'the run was still going when the failure appeared');
    await until(() => done(b), 'the fetch completes', 300000);
    assert(/hang first\.rtf\ttimed out/.test(await b.failures()), 'and it is still there at the end');
    s.kill('SIGTERM');
  }

  // ---------------- gate 5: the recovery eviction is logged ----------------
  if (want(5)) {
    const b = await brain('g5', sized(['rec one', 'rec two']), {});
    const s = await setUp(b);
    s.kill('SIGTERM');
    await sleep(500);
    // an earlier worker was cut off after downloading both files: they are on the disk (not online-only) and the batch list is left behind
    await fs.writeFile(b.dataless, '');
    await fs.writeFile(path.join(b.db, 'cloud-evict.json'), JSON.stringify(b.files.map(f => f.file)));
    const w = spawn(process.execPath, [serverScript, '--databrain-client', 'chatgpt', '--databrain-run-cloud-worker', '--databrain-job-id', '00000000-0000-4000-8000-000000000005'], { env: { ...process.env, ...b.env }, stdio: 'ignore', detached: true });
    w.unref();
    await until(async () => /cloud-worker\t[^\n]*recovery eviction: 2 file\(s\)/.test(await b.stageLog()), 'the recovery eviction is logged', 60000);
    const events = (await fs.readFile(b.events, 'utf8')).split('\n').filter(l => l.startsWith('evict '));
    assert(events.length >= 2, `both files were put back online-only: ${events.join(' | ')}`);
    await until(async () => !alive(w.pid), 'the worker has finished', 120000);
  }
  console.log('PASS: the ChatGPT cloud download works in sub-batches (every file reaches the index before macOS can take it back), `indexed` counts real rows, a file taken back is tried once more and then listed, a cancel stops a blocked reader within seconds and logs the end after it stopped, failures are written as they happen, and the recovery eviction is logged.');
} finally {
  spawnSync('/usr/bin/pkill', ['-f', 'sleep 600 # stuckreader']);
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
