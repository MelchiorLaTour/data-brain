// Cloud fetch in batches: download a batch, index its text, put the iCloud files back online-only, then the next batch. So it works when the
// free space is smaller than ALL the files but larger than one batch; the downloaded-and-not-evicted files never exceed one batch; every file is
// searchable afterwards; a batch bigger than the free space is refused with numbers and nothing is downloaded; a cancel in the middle of a batch
// still puts that batch's downloaded files back online-only. Online-only is SIMULATED with NB_TEST_DATALESS_LIST; a fake brctl re-adds the evicted file.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-batches-')));
const home = path.join(temp, 'home');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 180000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Notes');
await fs.mkdir(icloud, { recursive: true });
const dir = await fs.realpath(icloud);
const words = ['quokkaone', 'quokkatwo', 'quokkathree', 'quokkafour', 'quokkafive', 'quokkasix'];
const files = words.map(word => path.join(dir, `${word}.md`));
for (const [i, file] of files.entries()) await fs.writeFile(file, `# Note ${i}\n${words[i]} `.padEnd(2000, `${words[i]} filler text. `) + '\n');
await fs.writeFile(path.join(dir, 'local.md'), '# Local\nan ordinary local file that is already on this Mac.\n');
const SIZE = (await fs.stat(files[0])).size;
const roots = [path.dirname(dir)];
const dataless = path.join(temp, 'dataless.txt');
const evictLog = path.join(temp, 'evicted.log');
const fakeBrctl = path.join(temp, 'brctl');
// the fake brctl: records how many of the test files are on the disk at that moment, then makes the file online-only again
await fs.writeFile(fakeBrctl, `#!/bin/bash
f="$2"
total=${files.length}
off=$(grep -c . "${dataless}" || true)
echo "evict $(basename "$f") local=$((total - off))" >> "${evictLog}"
echo "$f" >> "${dataless}"
`, { mode: 0o755 });
const dataHome = path.join(home, 'DataBrain');
const resetOffline = async () => { await fs.writeFile(dataless, files.join('\n') + '\n'); await fs.writeFile(evictLog, ''); };
await resetOffline();

async function session(env, run) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, NB_TEST_DATALESS_LIST: dataless, NB_BRCTL: fakeBrctl, DATABRAIN_TEST_NO_AUTO_CLOUD: '1', DATABRAIN_TEST_CLOUD_BATCH_FILES: '2', DATABRAIN_TEST_CLOUD_MARGIN_BYTES: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool); }
  finally { child.kill('SIGTERM'); }
}
const indexText = () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8').catch(() => '');
const offline = async () => (await fs.readFile(dataless, 'utf8')).split('\n').filter(Boolean).length;
const settled = tool => async () => { const status = await tool('databrain_setup_status'); return /Stage: (?:verification pending|ready)\./.test(status) && !/: running — /.test(status); };

try {
  await session({}, async tool => {
    await tool('databrain_setup_start');
    await until(settled(tool), 'setup finished', 600000);
    assert.equal((await indexText()).includes('quokka'), false, 'online-only files are not indexed by setup');
  });

  // free space smaller than one batch (2 files): refused with the numbers, nothing downloaded
  await session({ DATABRAIN_TEST_FREE_KB: '1' }, async tool => {
    const refused = await tool('databrain_cloud_fetch');
    assert(/Not enough free disk space, so nothing was downloaded/.test(refused) && /largest batch \(2 file\(s\)/.test(refused) && /free\./.test(refused), refused);
    assert.equal(await offline(), files.length, 'nothing may be downloaded when one batch does not fit');
  });

  // free space smaller than ALL the files (6 x SIZE) but larger than one batch (2 x SIZE): runs in batches
  await session({ DATABRAIN_TEST_FREE_KB: String(Math.ceil(SIZE * 3 / 1024)) }, async tool => {
    const started = await tool('databrain_cloud_fetch');
    assert(/Downloading 6 online-only files/.test(started) && /3 batches/.test(started), started);
    await until(async () => (await indexText()).split('\n').filter(line => line.includes('quokka')).length === 6 && await offline() === 6, 'all six indexed and put back online-only');
    await until(settled(tool), 'settled again');
    const log = (await fs.readFile(evictLog, 'utf8')).split('\n').filter(Boolean);
    assert.equal(log.length, 6, `every iCloud file is put back online-only: ${log}`);
    const peak = Math.max(...log.map(line => Number(/local=(\d+)/.exec(line)[1])));
    assert(peak <= 2, `the downloaded-and-not-evicted files never exceed one batch (2); peak ${peak}: ${log.join(' | ')}`);
    for (const word of words) assert(/quokka/.test(await tool('databrain_search', { query: word })), `${word} is searchable after it went back online-only`);
    const verify = await tool('databrain_verify_install');
    assert.deepEqual(verify.split('\n').filter(line => /FAIL/.test(line) && !/GitHub release match/.test(line)), [], verify);
  });

  // cancel in the middle of a batch: what that batch downloaded still goes back online-only, and no later batch starts
  // (the six files above are already indexed with text, so they are not pending any more; four new ones are)
  const extra = ['wombatone', 'wombattwo', 'wombatthree', 'wombatfour'].map(word => path.join(dir, `${word}.md`));
  for (const file of extra) await fs.writeFile(file, `# ${path.basename(file)}\n`.padEnd(2000, `${path.basename(file)} filler text. `) + '\n');
  await fs.writeFile(dataless, [...files, ...extra].join('\n') + '\n');
  await fs.writeFile(evictLog, '');
  await session({ DATABRAIN_TEST_FREE_KB: String(Math.ceil(SIZE * 3 / 1024)), DATABRAIN_TEST_UPDATE_DELAY_MS: '6000' }, async tool => {
    const started = await tool('databrain_cloud_fetch');
    assert(/Downloading 4 online-only files/.test(started), started);
    const id = /job ([0-9a-f-]{36})/.exec(started)?.[1];
    assert(id, started);
    await until(async () => (await offline()) <= 8, 'first batch downloaded');
    await tool('databrain_cancel_job', { job_id: id });
    await until(async () => (await fs.readFile(evictLog, 'utf8')).split('\n').filter(Boolean).length >= 2, 'the cancelled batch was put back online-only', 60000);
    await sleep(1500);
    const log = (await fs.readFile(evictLog, 'utf8')).split('\n').filter(Boolean);
    assert.equal(log.length, 2, `exactly the cancelled batch is put back: ${log}`);
    assert.equal(await offline(), 10, 'nothing stays downloaded and no later batch was started');
  });
  console.log('PASS: cloud fetch runs in batches (works with less free space than all files, never more than one batch on the disk, every file searchable and put back online-only, refused with numbers when one batch does not fit, a cancel still puts the batch back).');
} finally {
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
