// When the results of a search span more than one page, the first page also lists facts about ALL of them (0.1.31): how many sit in each folder and in
// each year (the year the file was last changed). Later pages and one-page results carry no overview. Wording is facts only.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-overview-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pad = n => String(n).padStart(3, '0');
const groups = [['alpha', 120, 2024], ['beta', 90, 2025], ['gamma', 10, 2023]];
for (const [folder, count, year] of groups) {
  await fs.mkdir(path.join(docs, folder), { recursive: true });
  for (let i = 1; i <= count; i++) {
    const file = path.join(docs, folder, `${folder}-${pad(i)}.md`);
    await fs.writeFile(file, `# ${folder} note ${i}\nThe overviewzulu detail of ${folder} note ${i} sits here with some more words around it.\n`);
    await fs.utimes(file, new Date(`${year}-06-15T12:00:00Z`), new Date(`${year}-06-15T12:00:00Z`));
  }
}
for (let i = 1; i <= 3; i++) await fs.writeFile(path.join(docs, `tiny-${i}.md`), `# Tiny ${i}\nThe tinyzulu detail ${i}.\n`);
let n = 0;
const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const until = async (check, label, limit = 700000) => { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); };
try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => /Stage: ready\./.test(await tool('databrain_setup_status')), 'setup reaches ready');
  await until(async () => /of 220\./.test(await tool('databrain_search', { query: 'overviewzulu' })) && /of 3\./.test(await tool('databrain_search', { query: 'tinyzulu' })), 'notes are searchable');
  await sleep(1500);
  const first = await tool('databrain_search', { query: 'overviewzulu' });
  const lines = first.split('\n');
  assert(/Results 1-100 of 220\./.test(lines.find(line => /^Results /.test(line)) || ''), `page 1 header:\n${first.slice(0, 300)}`);
  assert(lines.includes('Overview of all 220 results: 100 on this page, 120 not shown yet.'), `the overview gives the total and how many are not shown:\n${first.slice(0, 500)}`);
  assert(lines.includes('By folder: alpha 120, beta 90, gamma 10.'), `counts by folder, largest first:\n${first.slice(0, 500)}`);
  assert(lines.includes('By year (file last changed): 2025 90, 2024 120, 2023 10.'), `counts by year, newest first:\n${first.slice(0, 500)}`);
  assert(lines.indexOf('By folder: alpha 120, beta 90, gamma 10.') < lines.findIndex(line => /^From your files:/.test(line)), 'the overview comes before the hits');
  const second = await tool('databrain_search', { query: 'overviewzulu', offset: 100 });
  assert(!/Overview of all/.test(second) && /Results 101-200 of 220\./.test(second), `a later page has no overview:\n${second.slice(0, 200)}`);
  const tiny = await tool('databrain_search', { query: 'tinyzulu' });
  assert(!/Overview of all/.test(tiny) && /Results 1-3 of 3\./.test(tiny), `a one-page result has no overview:\n${tiny.slice(0, 200)}`);
  const some = await tool('databrain_search', { query: 'overviewzulu', limit: 10 });
  assert(some.includes('Overview of all 220 results: 10 on this page, 210 not shown yet.'), `with a smaller page the counts follow it:\n${some.slice(0, 300)}`);
  console.log('PASS: the first page of a multi-page search lists the total, how many are not shown yet, and counts by folder and by year; later pages and one-page results have none.');
} finally {
  child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
