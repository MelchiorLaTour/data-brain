// Part 36 (ChatGPT host): large documents and workbooks are indexed by NAME ONLY (never downloaded or read), and a stuck download cannot block the batch.
// Fake HOME, invented files; "online-only" is SIMULATED (NB_TEST_DATALESS_LIST, fake brctl); Spotlight's page count is a fake mdls (NB_TEST_MDLS).
//   Gate 1  150 pages -> name only; 50 pages -> downloaded and indexed; "Workbook" in the name (10 pages) -> name only; "cahier d'exercices" -> name only;
//           no page count and over the size limit -> name only; no page count and small -> downloaded; a file whose page count only shows after the
//           download (200) -> name only, its content never indexed.
//   Gate 2  name-only files are found by a search for their name; none of their content words is anywhere in the brain folder; the cloud check says how many.
//   Gate 3  a download that hangs forever is skipped after the (short, test) limit, listed with "timed out", counted as failed, put back online-only,
//           and the other files of its batch are still indexed.
// Usage: node test_chatgpt_name_only.mjs [server.mjs]
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-nameonly-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 240000) { for (const t0 = Date.now(); !(await check()); await sleep(200)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

async function brain(name, specs, extraEnv = {}, { local = false } = {}) {
  const home = path.join(temp, name, 'home');
  const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Notes');
  await fs.mkdir(icloud, { recursive: true });
  const dir = await fs.realpath(icloud);
  const files = [];
  for (const spec of specs) {
    const file = path.join(dir, spec.name);
    const src = path.join(temp, name, `${spec.marker}.src.txt`);
    await fs.writeFile(src, `${spec.marker} `.padEnd(spec.size || 400, `${spec.marker} some words about nothing. `));
    execFileSync('textutil', ['-convert', spec.name.split('.').pop(), src, '-output', file]);
    files.push({ ...spec, file });
  }
  await fs.writeFile(path.join(dir, 'local.md'), '# Local\nan ordinary local file that is already on this Mac.\n');
  const dataless = path.join(temp, name, 'dataless.txt');
  const events = path.join(temp, name, 'events.log');
  const brctl = path.join(temp, name, 'brctl');
  await fs.writeFile(brctl, `#!/bin/bash\necho "evict $2" >> "${events}"\necho "$2" >> "${dataless}"\n`, { mode: 0o755 });
  await fs.writeFile(dataless, local ? '' : files.map(f => f.file).join('\n') + '\n');
  await fs.writeFile(events, '');
  // fake Spotlight: the page count by file name; "late" only shows a page count once the file is on the disk (not in the online-only list)
  const mdls = path.join(temp, name, 'mdls');
  await fs.writeFile(mdls, `#!/bin/bash
f="\${@: -1}"; b="$(basename "$f")"
case "$b" in
  ${specs.filter(s => s.pages).map(s => `"${s.name}") echo ${s.pages} ;;`).join('\n  ')}
  late*) if grep -qxF "$f" "${dataless}"; then echo "(null)"; else echo 200; fi ;;
  *) echo "(null)" ;;
esac
`, { mode: 0o755 });
  const dataHome = path.join(home, 'DataBrain');
  const read = file => fs.readFile(file, 'utf8').catch(() => '');
  const env = {
    HOME: home, NB_TEST_DATALESS_LIST: dataless, NB_BRCTL: brctl, NB_TEST_MDLS: mdls, DATABRAIN_TEST_DOWNLOAD_LOG: events, NB_TEST_NAME_ONLY_BYTES: '3000',
    DATABRAIN_TEST_FREE_KB: '100000000', DATABRAIN_TEST_CLIENT: 'chatgpt', DATABRAIN_TEST_NO_AUTO_CLOUD: '1', ...extraEnv,
  };
  return {
    name, home, dir, files, env, dataHome, dataless, events,
    state: async () => JSON.parse(await read(path.join(dataHome, '.databrain', 'desktop-state.json')) || '{}'),
    indexText: () => read(path.join(dataHome, 'moc', 'index.tsv')),
    failures: () => read(path.join(dataHome, '.databrain', 'cloud-fetch-failures.tsv')),
    progress: async () => JSON.parse(await read(path.join(dataHome, '.databrain', 'cloud-fetch-progress.json')) || '{}'),
    eventLines: async () => (await read(events)).split('\n').filter(Boolean),
    offline: async () => (await read(dataless)).split('\n').filter(Boolean),
    grepBrain: needle => spawnSync('/usr/bin/grep', ['-rla', needle, dataHome], { encoding: 'utf8' }).stdout.trim(),
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
const downloaded = async b => (await b.eventLines()).filter(l => l.startsWith('download ')).map(l => path.basename(l.slice(9)));

try {
  // ---------------- gates 1 and 2: which files are name only ----------------
  {
    const specs = [
      { name: 'Big Textbook.rtf', marker: 'bigtextmarker', pages: 150 },
      { name: 'Mid Guide.rtf', marker: 'midguidemarker', pages: 50 },
      { name: 'Physics Workbook.rtf', marker: 'physworkmarker', pages: 10 },
      { name: "cahier d'exercices maths.rtf", marker: 'cahiermarker' },
      { name: 'Huge Unknown.rtf', marker: 'hugeunknownmarker', size: 6000 },
      { name: 'Small Unknown.rtf', marker: 'smallunknownmarker' },
      { name: 'late reveal.rtf', marker: 'latemarker' },
    ];
    const b = await brain('g1', specs);
    const s = server(b);
    await s.ready;
    await s.tool('databrain_setup_start');
    await until(settled(s.tool), 'setup finished', 600000);
    assert.equal((await b.indexText()).includes('Big Textbook'), false, 'online-only files are not rows after setup');
    const started = await s.tool('databrain_cloud_fetch');
    assert(/Downloading 3 online-only files/.test(started), started);
    assert(/4 large documents or workbooks[^.]*are indexed by name only and not downloaded/.test(started), `the reply names the name-only documents:\n${started}`);
    await until(async () => (await b.state()).cloudFetchJob?.status === 'complete', 'the cloud fetch is complete', 300000);
    // 3 downloaded: Mid Guide (50 pages), Small Unknown (no count, small), late reveal (no count before the download); Big, Workbook, cahier, Huge are never downloaded
    const got = (await downloaded(b)).sort();
    assert.deepEqual(got, ['Mid Guide.rtf', 'Small Unknown.rtf', 'late reveal.rtf'], `only these are downloaded: ${got.join(', ')}`);
    const rows = await b.indexText();
    for (const name of ['Big Textbook', 'Mid Guide', 'Physics Workbook', "cahier d'exercices maths", 'Huge Unknown', 'Small Unknown', 'late reveal']) assert(rows.includes(name), `${name} has an index row (found by its name):\n${rows}`);
    // content: only Mid Guide and Small Unknown are indexed
    await until(async () => b.grepBrain('midguidemarker') !== '' && b.grepBrain('smallunknownmarker') !== '', 'the downloaded files are searchable');
    for (const marker of ['bigtextmarker', 'physworkmarker', 'cahiermarker', 'hugeunknownmarker', 'latemarker']) assert.equal(b.grepBrain(marker), '', `${marker} (name-only content) must not be anywhere in the brain folder`);
    // everything is back online-only
    await until(async () => (await b.offline()).length === specs.length, 'every file is online-only again');
    // gate 2: found by name; the report says how many
    const found = await s.tool('databrain_search', { query: 'Physics Workbook' });
    assert(/Physics Workbook/.test(found), `a search for the name finds it:\n${found}`);
    assert(!/Physics Workbook/.test(await s.tool('databrain_search', { query: 'physworkmarker' })), 'its content words find nothing (the answer repeats the query word, so look for the file, not the word)');
    const check = await s.tool('databrain_cloud_check');
    assert(/5 large document\(s\) and workbook\(s\)[^.]*indexed by name only/.test(check), `the cloud check reports how many are name only:\n${check}`);
    assert(!/Cloud-only files waiting: [1-9]/.test(await s.tool('databrain_diagnostics')), 'name-only files are not "waiting to download"');
    assert(/by name only/.test((await b.state()).cloudFetchJob?.message || ''), `the job result says how many: ${(await b.state()).cloudFetchJob?.message}`);
    s.kill('SIGTERM');
  }

  // ---------------- gate 3: a download that hangs ----------------
  {
    const hang = path.join(temp, 'hangprogram');
    await fs.writeFile(hang, '#!/bin/bash\ncase "$1" in *hang*) exec sleep 600 ;; *) exec /bin/cat "$1" ;; esac\n', { mode: 0o755 });
    const specs = [
      { name: 'hang forever.rtf', marker: 'hangmarker' },
      { name: 'fine one.rtf', marker: 'fineonemarker' },
      { name: 'fine two.rtf', marker: 'finetwomarker' },
    ];
    const b = await brain('g3', specs, { DATABRAIN_TEST_DOWNLOAD_PROGRAM: hang, DATABRAIN_TEST_DOWNLOAD_TIMEOUT_MS: '1500', DATABRAIN_TEST_CLOUD_BATCH_FILES: '3' });
    const s = server(b);
    await s.ready;
    await s.tool('databrain_setup_start');
    await until(settled(s.tool), 'setup finished', 600000);
    const t0 = Date.now();
    await s.tool('databrain_cloud_fetch');
    await until(async () => (await b.state()).cloudFetchJob?.status === 'complete', 'the fetch completes although one download hangs', 120000);
    assert(Date.now() - t0 < 100000, 'the hang cost about the short limit, not minutes');
    await until(async () => b.grepBrain('fineonemarker') !== '' && b.grepBrain('finetwomarker') !== '', 'the other files of the batch are indexed');
    assert.equal(b.grepBrain('hangmarker'), '', 'the hung file was not indexed');
    const failures = await b.failures();
    assert(/hang forever\.rtf\ttimed out/.test(failures), `the stuck file is listed with "timed out":\n${failures}`);
    const progress = await b.progress();
    assert.equal(progress.failed, 1, `failures are counted in the progress: ${JSON.stringify(progress)}`);
    const events = await b.eventLines();
    assert(events.some(l => l.startsWith('evict ') && l.includes('hang forever.rtf')), `the stuck file was put back online-only:\n${events.join('\n')}`);
    assert((await b.offline()).some(f => f.includes('hang forever.rtf')), 'it is online-only in the end');
    assert.equal(spawnSync('/usr/bin/pgrep', ['-f', 'sleep 600']).stdout.toString().trim(), '', 'the stuck reader was killed');
    s.kill('SIGTERM');
  }
  // ---------------- gate 4: the same rules for files that are already on this Mac ----------------
  {
    const specs = [
      { name: 'Local Big.rtf', marker: 'localbigmarker', pages: 150 },
      { name: 'Local Workbook.rtf', marker: 'localworkmarker', pages: 5 },
      { name: 'Local Normal.rtf', marker: 'localnormalmarker', pages: 20 },
    ];
    const b = await brain('g4', specs, {}, { local: true });
    const s = server(b);
    await s.ready;
    await s.tool('databrain_setup_start');
    await until(settled(s.tool), 'setup finished', 600000);
    const rows = await b.indexText();
    for (const name of ['Local Big', 'Local Workbook', 'Local Normal']) assert(rows.includes(name), `${name} has a row:\n${rows}`);
    await until(async () => b.grepBrain('localnormalmarker') !== '', 'the ordinary local document is indexed with its content');
    for (const marker of ['localbigmarker', 'localworkmarker']) assert.equal(b.grepBrain(marker), '', `${marker}: a local large document or workbook is name only too`);
    assert(/Local Big/.test(await s.tool('databrain_search', { query: 'Local Big' })), 'found by its name');
    s.kill('SIGTERM');
  }
  console.log('PASS: large documents and workbooks (more than 100 pages, "workbook", "cahier d\'exercices", no page count over the size limit, or a page count seen only after the download) are indexed by name only and never read; a hung download is skipped as "timed out" and the rest of the batch is indexed.');
} finally {
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
