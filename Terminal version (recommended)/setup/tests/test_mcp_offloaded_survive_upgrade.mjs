// A new build installed OVER an existing brain must never touch files that were indexed and later went online-only (iCloud "Optimize Storage"):
// none is downloaded (opened), re-queued for download, or counted missing, and their text stays searchable. Covers a plain note (search row), a text
// file and an RTF (extract sidecar), plus (part 9) a scan with no text layer (the 4th cloud-only file) and a file the user excluded (never indexed). The offloaded copies are replaced by POISON text, so any re-read would show up in search; a stub on the engine's
// PATH also logs every textutil/pdftotext call that names one of them. Online-only is simulated with NB_TEST_DATALESS_LIST.
// A change that needs a full re-index must reuse the stored text (sidecars / search rows), never the sources: this gate fails if it does not.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-offload-upgrade-')));
// private copy of the server folder: the engine puts <server dir>/runtime/bin first on its PATH, so call-logging stubs can sit there
const realServerDir = path.dirname(serverScript);
const engineDir = process.env.DATABRAIN_ENGINE_DIR || path.resolve(realServerDir, '../..');
const copyDir = path.join(temp, 'mcp');
await fs.cp(realServerDir, copyDir, { recursive: true });
const serverCopy = path.join(copyDir, 'server.mjs');
const callLog = path.join(temp, 'calls.log');
await fs.mkdir(path.join(copyDir, 'runtime', 'bin'), { recursive: true });
for (const tool of ['textutil', 'osascript']) {   // osascript is the PDF reader when pdftotext is not on the engine PATH (as on a plain Mac)
  const real = `/usr/bin/${tool}`;
  await fs.writeFile(path.join(copyDir, 'runtime', 'bin', tool), `#!/bin/bash\necho "${tool} $*" >> "${callLog}"\n[ -x ${real} ] && exec ${real} "$@"\nexit 127\n`, { mode: 0o755 });
}

const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); const sub = path.join(docs, 'Offloaded');
await fs.mkdir(sub, { recursive: true });
const items = [
  { file: path.join(sub, 'soup.md'), word: 'offloadsoupmd', body: '# Soup\noffloadsoupmd the soup has 3 carrots and 1 lemon.\n' },
  { file: path.join(sub, 'plan.txt'), word: 'offloadplantxt', body: 'offloadplantxt the plan has 4 steps and a deadline.\n' },
  { file: path.join(sub, 'letter.rtf'), word: 'offloadletterrtf', body: '{\\rtf1\\ansi offloadletterrtf the letter has 2 pages.\\par}\n' },
];
for (const item of items) await fs.writeFile(item.file, item.body);
// a PDF that opens fine but has no text layer (a scan): the first build ends it as no_text_layer, a final outcome
const blankPdf = extra => {
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 4\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size 4/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n${extra}`;
  return out;
};
const scanPdf = path.join(sub, 'scan-receipt.pdf');
await fs.writeFile(scanPdf, blankPdf(''));
await fs.writeFile(path.join(docs, 'plain.md'), '# Plain\nplainmarker an ordinary local note.\n');
const list = path.join(temp, 'dataless.txt'); await fs.writeFile(list, '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [];
async function session(run) {
  let n = 0;
  const child = spawn(process.execPath, [serverCopy, '--databrain-source-roots', docs], { env: { ...process.env, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300', HOME: home, DATABRAIN_ENGINE_DIR: engineDir, NB_TEST_DATALESS_LIST: list, DATABRAIN_FRESHNESS_CHECK_MS: '3600000', DATABRAIN_TEST_NO_AUTO_CLOUD: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool); }
  finally { child.kill('SIGTERM'); await sleep(800); }
}
const until = async (check, label, limit = 180000) => { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); };
const idle = tool => async () => { await until(async () => { const s = await tool('databrain_setup_status'); return /Stage: (?:verification pending|ready)\./.test(s) && !/(refresh|index housekeeping|app check|relationship report|cloud fetch): running/.test(s); }, 'jobs idle'); await sleep(600); };
const calls = async () => (await fs.readFile(callLog, 'utf8').catch(() => '')).split('\n').filter(line => line.includes(sub));

try {
  // 1. first build: everything on this Mac, indexed in full
  await session(async tool => {
    await tool('databrain_setup_start');
    await until(async () => /Stage: (?:verification pending|ready)\./.test(await tool('databrain_setup_status')), 'setup reaches ready', 30000).catch(async error => { throw new Error(`${error.message}\n${(await tool('databrain_setup_status')).slice(0, 1500)}`); });
    await idle(tool)();
    for (const item of items) assert(new RegExp(path.basename(item.file)).test(await tool('databrain_search', { query: item.word })), `before: ${item.word} is found`);
  });

  const report = await fs.readFile(path.join(home, 'DataBrain', 'moc', 'extract-report.tsv'), 'utf8').catch(() => '');
  assert(/scan-receipt\.pdf\tno_text_layer\t\d+:\d+/.test(report), `the first build ends the scan as no_text_layer and stores its size and mtime:\n${report}`);

  // 2. macOS offloads them (the cloud copy now holds other bytes); then a NEW build is installed over the brain (new server process)
  await fs.writeFile(list, items.map(item => item.file).join('\n') + '\n');
  await sleep(1100);
  for (const item of items) {
    await fs.writeFile(item.file, item.file.endsWith('.rtf') ? '{\\rtf1\\ansi POISONREREAD changed after offload.\\par}\n' : 'POISONREREAD changed after offload.\n');
  }
  // part 9: the no-text PDF goes online-only too; and a file the user EXCLUDED at the privacy review (never indexed) is online-only as well
  const excludedFile = path.join(sub, 'bank-statement.pdf');
  await fs.writeFile(excludedFile, blankPdf('% excluded'));
  await fs.appendFile(path.join(home, 'DataBrain', '.databrain', 'privacy.tsv'), `excluded\t${excludedFile}\tlooks private\n`);
  await fs.writeFile(list, [...items.map(item => item.file), scanPdf, excludedFile].join('\n') + '\n');
  await fs.writeFile(callLog, '');
  await session(async tool => {
    await until(async () => /Stage: (?:verification pending|ready)\./.test(await tool('databrain_setup_status')), 'new build comes up ready');
    await idle(tool)();
    // the things a user runs after an upgrade
    await tool('databrain_setup_start'); await idle(tool)();
    await tool('databrain_refresh'); await sleep(1500); await idle(tool)();
    const check = await tool('databrain_cloud_check');
    assert(!/POISON/.test(check), check);
    const verify = await tool('databrain_verify_install');
    assert.deepEqual(verify.split('\n').filter(line => /FAIL/.test(line) && !/GitHub release match/.test(line)), [], verify);
    await tool('databrain_repair'); await sleep(1500); await idle(tool)();
    await tool('databrain_health');

    // nothing re-read, nothing re-queued, nothing missing, text still searchable
    assert(/No online-only cloud files are waiting to be downloaded/.test(check), `cloud_check queues nothing:\n${check}`);
    assert(/1 online-only file\(s\) have no readable text/.test(check) && check.includes('Those files are private and cannot be accessed for privacy reasons.') && !/excluded at the privacy review/.test(check) && /not downloaded and are not counted as waiting/.test(check), `cloud_check counts the two groups in plain words:\n${check}`);
    const pending = await fs.readFile(path.join(home, 'DataBrain', 'moc', 'cloud-pending.tsv'), 'utf8').catch(() => '');
    for (const item of items) assert(!pending.includes(path.basename(item.file)), `${path.basename(item.file)} was re-queued for download`);
    assert(!pending.includes('bank-statement.pdf'), 'an excluded online-only file was queued for download');
    assert(!pending.includes('scan-receipt.pdf'), 'an online-only scan with a final no-text outcome was queued for download');
    for (const item of items) {
      const found = await tool('databrain_search', { query: item.word });
      assert(new RegExp(path.basename(item.file)).test(found), `${path.basename(item.file)} stays searchable by its indexed text:\n${found}`);
    }
    const poisoned = await tool('databrain_search', { query: 'POISONREREAD' });
    assert(!/soup\.md|plan\.txt|letter\.rtf/.test(poisoned), `the changed bytes of an offloaded file were read into the index:\n${poisoned}`);
    const index = await fs.readFile(path.join(home, 'DataBrain', 'moc', 'index.tsv'), 'utf8');
    for (const item of items) assert(index.includes(path.basename(item.file)), `${path.basename(item.file)} was pruned as missing`);
    const status = await tool('databrain_setup_status');
    assert(/4 indexed files are now cloud-only on this Mac \(still searchable\)\./.test(status), `status counts them as cloud-only, not as a gap:\n${status.slice(0, 900)}`);
    assert(!/online-only cloud files not downloaded yet/.test(status), 'and lists no gap');
    const opened = await calls();
    assert.deepEqual(opened, [], `an offloaded file was opened (that downloads it):\n${opened.join('\n')}`);
    const reportNow = await fs.readFile(path.join(home, 'DataBrain', 'moc', 'extract-report.tsv'), 'utf8');
    assert(/scan-receipt\.pdf\tno_text_layer/.test(reportNow), 'the scan keeps its final outcome after refresh and repair');
    // the same scan with a changed size IS queued again; an mtime-only change too (a ctime-only move is not a change)
    await fs.writeFile(scanPdf, blankPdf('% a new version, different size'));
    const changed = await tool('databrain_cloud_check');
    assert(/1 file\(s\)/.test(changed) && /have not been indexed/.test(changed), `a changed scan is waiting again:\n${changed}`);
    assert(!/no readable text/.test(changed), `and is no longer counted as settled:\n${changed}`);
    assert(!/bank-statement/.test(await fs.readFile(path.join(home, 'DataBrain', 'moc', 'cloud-pending.tsv'), 'utf8')), 'the excluded file stays out');
  });
  console.log('PASS: a new build installed over a brain with indexed-then-offloaded files (setup, refresh, repair, verify, cloud check) downloads, re-queues and prunes none of them; their text stays searchable.');
} finally {
  for (const child of children) child.kill('SIGKILL');
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
