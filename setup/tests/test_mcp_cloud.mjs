// Cloud drives: online-only files are never read during indexing; databrain_cloud_check lists them per provider with counts and sizes;
// databrain_cloud_fetch checks free space, downloads one at a time (by reading), indexes them, and re-offloads iCloud files.
// The online-only state is SIMULATED (a list of paths); real OneDrive, Google Drive, Dropbox and iCloud are not tested here.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-cloud-')));
const home = path.join(temp, 'home');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const grepAll = (needle, dir) => spawnSync('/usr/bin/grep', ['-rlaF', needle, dir], { encoding: 'utf8' }).stdout.trim();

const oneDrive = path.join(home, 'Library', 'CloudStorage', 'OneDrive-Test');
const googleDrive = path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-me@example.com');
const iCloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
for (const dir of [path.join(oneDrive, 'Docs'), path.join(googleDrive, 'My Drive'), path.join(iCloud, 'Notes')]) await fs.mkdir(dir, { recursive: true });
const files = {
  onedrive: path.join(await fs.realpath(oneDrive), 'Docs', 'onedrive-a.md'),
  gdrive: path.join(await fs.realpath(googleDrive), 'My Drive', 'gdrive-b.md'),
  icloud: path.join(await fs.realpath(iCloud), 'Notes', 'icloud-c.md'),
  local: path.join(await fs.realpath(oneDrive), 'Docs', 'local.md'),
};
await fs.writeFile(files.onedrive, '# A\nonedrivemarker text that only exists online.\n'.repeat(40));
await fs.writeFile(files.gdrive, '# B\ngdrivemarker text that only exists online.\n'.repeat(40));
await fs.writeFile(files.icloud, '# C\nicloudmarker text that only exists online.\n'.repeat(40));
await fs.writeFile(files.local, '# Local\nlocalcloudmarker an ordinary local file.\n');
await fs.writeFile(path.join(await fs.realpath(googleDrive), 'My Drive', 'plan.gdoc'), '{"url":"https://docs.google.com/document/d/x"}');
const roots = [await fs.realpath(oneDrive), await fs.realpath(googleDrive), await fs.realpath(iCloud)];
const simulated = path.join(temp, 'dataless.txt');
await fs.writeFile(simulated, `${files.onedrive}\n${files.gdrive}\n${files.icloud}\n`);
const evictLog = path.join(temp, 'evicted.log');
const fakeBrctl = path.join(temp, 'brctl');
await fs.writeFile(fakeBrctl, `#!/bin/bash\necho "$@" >> "${evictLog}"\n`, { mode: 0o755 });
const dataHome = path.join(home, 'DataBrain');

async function session(env, run) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, NB_TEST_DATALESS_LIST: simulated, NB_BRCTL: fakeBrctl, DATABRAIN_TEST_NO_AUTO_CLOUD: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool, ask); }
  finally { child.kill('SIGTERM'); }
}
const indexText = () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');

try {
  await session({}, async (tool, ask) => {
    const specs = (await ask('tools/list', {})).result.tools.map(t => t.name);
    assert(specs.includes('databrain_cloud_check') && specs.includes('databrain_cloud_fetch'), 'both cloud tools must be listed');
    await tool('databrain_setup_start');
    await until(async () => /Stage: (?:verification pending|ready)\./.test((await tool('databrain_setup_status'))), 'setup finished');
    // online-only files were never read or indexed
    const rows = await indexText();
    assert(rows.includes('local.md') && !rows.includes('onedrive-a.md') && !rows.includes('gdrive-b.md') && !rows.includes('icloud-c.md'), `only the local file may be indexed:\n${rows}`);
    for (const marker of ['onedrivemarker', 'gdrivemarker', 'icloudmarker']) assert.equal(grepAll(marker, dataHome), '', `${marker} must not be read during indexing`);
    // check: per provider, counts, sizes, Google Docs shortcut note; nothing downloaded
    const report = await tool('databrain_cloud_check');
    assert(/3 file\(s\), about \d+(\.\d)? (KB|MB|GB), are only online/.test(report), report);
    assert(/- OneDrive: 1 file\(s\), about/.test(report) && /- Google Drive: 1 file\(s\), about/.test(report) && /- iCloud Drive: 1 file\(s\), about/.test(report), report);
    assert(/The user agreed at setup to these temporary downloads\./.test(report), 'the report says the download was agreed at setup');
    assert(/call databrain_cloud_fetch without asking again/.test((await ask('tools/list', {})).result.tools.find(spec => spec.name === 'databrain_cloud_check').description), 'the tool description tells Claude not to ask again (results carry facts only)');
    assert(/1 Google Docs, Sheets or Slides shortcut file\(s\)[^]*must be exported/.test(report), report);
    assert(!/gdoc/.test(await indexText()), 'shortcut files are skipped');
    assert.deepEqual((await fs.readFile(simulated, 'utf8')).split('\n').filter(Boolean).length, 3, 'checking must not download anything');
    assert(/Cloud-only files waiting: 3/.test(await tool('databrain_diagnostics')), 'diagnostics must include the cloud count');
  });
  // not enough free space: refused with numbers, nothing read
  await session({ DATABRAIN_TEST_FREE_KB: '1' }, async tool => {
    const refused = await tool('databrain_cloud_fetch');
    assert(/Not enough free disk space, so nothing was downloaded/.test(refused) && /free\./.test(refused), refused);
    assert.deepEqual((await fs.readFile(simulated, 'utf8')).split('\n').filter(Boolean).length, 3, 'nothing may be downloaded when space is short');
  });
  // downloads were agreed at setup (chat consent): no second question; one at a time, then indexed, iCloud re-offloaded
  await session({ DATABRAIN_TEST_FREE_KB: '100000000' }, async tool => {
    const started = await tool('databrain_cloud_fetch');
    assert(/Downloading 3 online-only files/.test(started) && /as agreed at setup/.test(started) && !/dialog|click/i.test(started), started);
    await until(async () => (await indexText()).includes('onedrive-a.md') && (await indexText()).includes('gdrive-b.md') && (await indexText()).includes('icloud-c.md'), 'fetched files indexed');
    await until(async () => { const status = await tool('databrain_setup_status'); return /Stage: (?:verification pending|ready)\./.test(status) && !/: running — /.test(status); }, 'settled again');   // 0.1.40: also no background job (the relationship report rebuilds by itself)
    assert.equal((await fs.readFile(simulated, 'utf8')).trim(), '', 'all three were downloaded');
    for (const marker of ['onedrivemarker', 'gdrivemarker', 'icloudmarker']) assert(grepAll(marker, dataHome) !== '', `${marker} must now be searchable`);
    await until(async () => (await fs.readFile(evictLog, 'utf8').catch(() => '')).includes('icloud-c.md'), 're-offload of the iCloud file');
    const evicted = await fs.readFile(evictLog, 'utf8');
    assert(evicted.includes('icloud-c.md') && !evicted.includes('onedrive-a.md') && !evicted.includes('gdrive-b.md'), `only iCloud files are re-offloaded: ${evicted}`);
    assert(/There are no online-only files to download/.test(await tool('databrain_cloud_fetch')), 'a second fetch finds nothing');
  });
  console.log('PASS: online-only files are never read during indexing; check lists per provider with counts and sizes; fetch checks free space, downloads one at a time, indexes, and re-offloads iCloud files. (Simulated; real OneDrive is untested.)');
} finally {
  await sleep(2000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
