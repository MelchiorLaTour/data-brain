// Cloud fetch speed: the batch size follows the free space, files are packed by size, and the whole-tree work (room pages, inventory, freshness
// baseline) runs once per fetch, not once per batch. Online-only is SIMULATED (NB_TEST_DATALESS_LIST + fake brctl). With BENCH=<n> it only prints how long
// a fetch of n small files takes, for comparing two builds (DATABRAIN_SERVER points at the build).
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-batch-speed-')));
const home = path.join(temp, 'home');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 180000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }


const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Notes');
await fs.mkdir(icloud, { recursive: true });
const dir = await fs.realpath(icloud);
await fs.writeFile(path.join(dir, 'local.md'), '# Local\nan ordinary local file that is already on this Mac.\n');
const roots = [path.dirname(dir)];
const dataless = path.join(temp, 'dataless.txt');
const fakeBrctl = path.join(temp, 'brctl');
await fs.writeFile(fakeBrctl, `#!/bin/bash\necho "$2" >> "${dataless}"\n`, { mode: 0o755 });
const dataHome = path.join(home, 'DataBrain');
const timingLog = path.join(dataHome, '.databrain', 'stage-timing.log');

async function makeFiles(prefix, sizes) {
  const made = [];
  for (const [i, size] of sizes.entries()) {
    const file = path.join(dir, `${prefix}${String(i).padStart(3, '0')}.md`);
    await fs.writeFile(file, `# ${prefix} ${i}\n${prefix}word${i} `.padEnd(size, `${prefix}word${i} filler text. `).slice(0, size - 1) + '\n');
    made.push(file);
  }
  return made;
}
const setOffline = files => fs.writeFile(dataless, files.join('\n') + '\n');

async function session(env, run) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300', HOME: home, NB_TEST_DATALESS_LIST: dataless, NB_BRCTL: fakeBrctl, DATABRAIN_TEST_NO_AUTO_CLOUD: '1', DATABRAIN_TEST_CLOUD_MARGIN_BYTES: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool); }
  finally { child.kill('SIGTERM'); }
}
const indexLines = async word => (await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8').catch(() => '')).split('\n').filter(line => line.includes(word)).length;
const settled = tool => async () => { const status = await tool('databrain_setup_status'); return /Stage: (?:verification pending|ready)\./.test(status) && !/: running — /.test(status); };
const engineRuns = async (script, kind) => (await fs.readFile(timingLog, 'utf8').catch(() => '')).split('\n').filter(line => line.includes(`engine:${script}`) && (!kind || line.includes(`\t${kind}\t`))).length;
const GB_KB = 1024 * 1024;

async function setup(tool) { await tool('databrain_setup_start'); await until(settled(tool), 'setup finished', 1500000); }

try {
  if (process.env.BENCH) {
    // BALLAST=<n>: n ordinary local notes already indexed, so every batch's whole-tree work has something to walk (a real brain has thousands).
    const ballast = Number(process.env.BALLAST || 0);
    if (ballast) {
      const ballastDir = path.join(dir, 'ballast'); await fs.mkdir(ballastDir, { recursive: true });
      for (let i = 0; i < ballast; i++) await fs.writeFile(path.join(ballastDir, `b${i}.md`), `---\ntags: [ballast${i % 50}]\n---\n# Ballast ${i}\nordinary local note number ${i} with some words ${i * 7}.\n`);
    }
    const files = await makeFiles('bench', Array(Number(process.env.BENCH)).fill(1500));
    await setOffline(files);
    await session({ DATABRAIN_TEST_FREE_KB: String(50 * GB_KB) }, async tool => {
      await setup(tool);
      const t0 = Date.now();
      await tool('databrain_cloud_fetch');
      await until(async () => await indexLines('benchword') === files.length, 'all indexed', 900000);
      await until(settled(tool), 'settled', 900000);
      console.log(`BENCH ${files.length} files: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      const sums = new Map();
      for (const line of (await fs.readFile(timingLog, 'utf8').catch(() => '')).split('\n')) {
        const m = /^\S+\t([^\t]+)\t\S+\t([^\t]+)\t(\d+)ms/.exec(line); if (!m || m[1] === 'initial indexing') continue;
        const key = `${m[1]} / ${m[2]}`; const old = sums.get(key) || { n: 0, ms: 0 }; sums.set(key, { n: old.n + 1, ms: old.ms + Number(m[3]) });
      }
      for (const [key, v] of [...sums].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8)) console.log(`  ${key}: ${v.n}x, ${(v.ms / 1000).toFixed(1)} s`);
    });
  } else {
    // 1. plenty of free space: 120 small files go in ONE batch (the old 50-file cap forced 3)
    const roomy = await makeFiles('roomy', Array(120).fill(1500));
    await setOffline(roomy);
    await session({ DATABRAIN_TEST_FREE_KB: String(50 * GB_KB) }, async tool => {
      await setup(tool);
      const started = await tool('databrain_cloud_fetch');
      assert(/Downloading 120 online-only files/.test(started) && /fetched in 1 batch /.test(started), started);
      await until(async () => await indexLines('roomyword') === 120, 'all 120 indexed');
      await until(settled(tool), 'settled');
      // the whole-tree work ran once for the fetch: extract once for the batch, room pages and inventory once at the end (not once per batch)
      assert.equal(await engineRuns('extract.sh', 'cloud fetch'), 1, 'one extract run for the one batch');
      assert.equal(await engineRuns('inventory.sh', 'cloud fetch'), 0, 'no inventory inside the cloud fetch job');
      assert.equal(await engineRuns('inventory.sh'), await engineRuns('inventory.sh', 'index housekeeping') + await engineRuns('inventory.sh', 'initial indexing'), 'inventory only in housekeeping');
    });

    // 2. tight free space: the floor (50 files per batch) as in part 6; 120 files = 3 batches, one extract each, inventory once at the end
    const tight = await makeFiles('tight', Array(120).fill(1500));
    await setOffline(tight);
    const invBefore = await engineRuns('inventory.sh');
    const extractBefore = await engineRuns('extract.sh', 'cloud fetch');
    await session({ DATABRAIN_TEST_FREE_KB: String(2 * GB_KB), DATABRAIN_TEST_CLOUD_MARGIN_BYTES: String(1024 ** 3) }, async tool => {
      const started = await tool('databrain_cloud_fetch');
      assert(/Downloading 120 online-only files/.test(started) && /fetched in 3 batches /.test(started), started);
      await until(async () => await indexLines('tightword') === 120, 'all 120 indexed in 3 batches');
      await until(settled(tool), 'settled');
      assert.equal(await engineRuns('extract.sh', 'cloud fetch') - extractBefore, 3, 'one extract per batch');
      assert.equal(await engineRuns('inventory.sh', 'cloud fetch'), 0, 'no inventory per batch');
      await until(async () => await engineRuns('inventory.sh') > invBefore, 'inventory ran at the end');
      await sleep(3000);
      assert.equal(await engineRuns('inventory.sh') - invBefore, 1, 'inventory ran once for the whole fetch, not once per batch');
    });

    // 3. packing by size, largest first: 1500 x4 then 2500 x2 (in name order) with a 4000-byte limit pack into 3 batches
    // (2500+1500, 2500+1500, 1500+1500); filling batches in name order would need 4.
    const packed = [...await makeFiles('pack', [1500, 1500, 1500, 1500, 2500, 2500])];
    await setOffline(packed);
    await session({ DATABRAIN_TEST_FREE_KB: String(2 * GB_KB), DATABRAIN_TEST_CLOUD_BATCH_BYTES: '4000', DATABRAIN_TEST_UPDATE_DELAY_MS: '1500' }, async tool => {
      const started = await tool('databrain_cloud_fetch');
      assert(/Downloading 6 online-only files/.test(started) && /fetched in 3 batches /.test(started), started);
      // 4. progress names the batch
      let seen = '';
      await until(async () => { const status = await tool('databrain_setup_status'); const m = /Cloud fetch: \d+ of 6 files, batch \d of 3/.exec(status); if (m) seen = m[0]; return Boolean(seen); }, 'progress line with the batch', 60000);
      assert(/batch [123] of 3/.test(seen), seen);
      await until(async () => await indexLines('packword') === 6, 'packed files indexed');
    });
    console.log('PASS: cloud batches follow the free space and are packed by size; the whole-tree work runs once per fetch; the progress line names the batch.');
  }
} finally {
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
