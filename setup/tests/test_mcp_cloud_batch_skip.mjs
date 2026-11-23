// One changing file in the middle batch must not kill the cloud fetch: 3 batches of 2; quokkafour (batch 2) has a ctime that keeps moving
// (iCloud) so it is left out, listed in cloud-fetch-failures.tsv with a short reason, and batches 1-3 all complete. quokkathree's ctime moves
// only once, so its second read succeeds and it is indexed and NOT listed. Online-only is SIMULATED (NB_TEST_DATALESS_LIST, fake brctl).
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-batch-skip-')));
// The engine puts <server dir>/runtime/bin first on its PATH, so a private copy of the server folder lets a stat stub sit there without touching the checkout.
const realServerDir = path.dirname(serverScript);
const engineDir = process.env.DATABRAIN_ENGINE_DIR || path.resolve(realServerDir, '../..');
const copyDir = path.join(temp, 'mcp');
await fs.cp(realServerDir, copyDir, { recursive: true });
const serverCopy = path.join(copyDir, 'server.mjs');
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
const statStub = path.join(copyDir, 'runtime', 'bin');
const marks = path.join(temp, 'marks');
await fs.mkdir(statStub, { recursive: true }); await fs.mkdir(marks, { recursive: true });
// stat stub: after the "before" fingerprint of a named file, move its ctime (once for quokkathree, every time for quokkafour)
await fs.writeFile(path.join(statStub, 'stat'), `#!/bin/bash
real=/usr/bin/stat
case "$*" in *'%i:%z:%m:%c'*) ;; *) exec $real "$@" ;; esac
file="\${@: -1}"
out="$($real "$@")" || exit $?
case "$file" in
  */quokkathree.md) [ -e "$STUB_MARKS/three" ] || { : > "$STUB_MARKS/three"; sleep 1.1; chmod u-w "$file"; chmod u+w "$file"; } ;;
  */quokkafour.md) sleep 1.1; chmod u-w "$file"; chmod u+w "$file" ;;
esac
printf '%s\\n' "$out"
`, { mode: 0o755 });
const dataHome = path.join(home, 'DataBrain');
const resetOffline = async () => { await fs.writeFile(dataless, files.join('\n') + '\n'); await fs.writeFile(evictLog, ''); };
await resetOffline();

async function session(env, run) {
  const child = spawn(process.execPath, [serverCopy, '--databrain-source-roots', ...roots], { env: { ...process.env, DATABRAIN_ENGINE_DIR: engineDir, STUB_MARKS: marks, HOME: home, NB_TEST_DATALESS_LIST: dataless, NB_BRCTL: fakeBrctl, DATABRAIN_TEST_NO_AUTO_CLOUD: '1', DATABRAIN_TEST_CLOUD_BATCH_FILES: '2', DATABRAIN_TEST_CLOUD_MARGIN_BYTES: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  await session({ DATABRAIN_TEST_FREE_KB: String(Math.ceil(SIZE * 3 / 1024)) }, async tool => {
    const started = await tool('databrain_cloud_fetch');
    assert(/Downloading 6 online-only files/.test(started) && /3 batches/.test(started), started);
    // every batch completes: all six go back online-only, five are indexed
    await until(async () => (await fs.readFile(evictLog, 'utf8')).split('\n').filter(Boolean).length === 6, 'all three batches completed (six evictions)');
    await until(settled(tool), 'settled again');
    const index = await indexText();
    for (const word of ['quokkaone', 'quokkatwo', 'quokkathree', 'quokkafive', 'quokkasix']) assert(index.includes(word), `${word} is indexed`);
    assert.equal(index.includes('quokkafour'), false, 'the file that kept changing is not indexed this time');
    for (const word of ['quokkaone', 'quokkathree', 'quokkasix']) assert(/quokka/.test(await tool('databrain_search', { query: word })), `${word} is searchable`);
    const failures = await fs.readFile(path.join(dataHome, '.databrain', 'cloud-fetch-failures.tsv'), 'utf8');
    assert.equal(failures.trim().split('\n').length, 1, `only the persistent file is listed: ${failures}`);
    assert(/quokkafour\.md\tchanged while being read/.test(failures), failures);
    assert.equal(failures.includes('quokkathree'), false, 'a file indexed on the second read is not listed');
    assert.equal(/body|SECRET|filler text/.test(failures), false, 'the list holds paths and reasons only');
    const timing = await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8');
    assert(/ingest-skipped\t[^\n]*1 file\(s\) left out/.test(timing), 'the left-out count is in stage-timing.log');
    assert.equal(/cloud fetch\t[^\n]*job-end failed/.test(timing) || /cloud fetch[^\n]*failed/.test(timing), false, 'the fetch job did not fail');
    const diagnostics = await tool('databrain_diagnostics');
    assert(/Cloud download failures \(last fetch, top reasons\): 1 changed while being read/.test(diagnostics), diagnostics);
    const verify = await tool('databrain_verify_install');
    assert.deepEqual(verify.split('\n').filter(line => /FAIL/.test(line) && !/GitHub release match/.test(line)), [], verify);
  });
  console.log('PASS: a file that keeps changing in batch 2 is left out and listed; all three batches complete; a file whose ctime moved once is indexed on the second read.');
} finally {
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
