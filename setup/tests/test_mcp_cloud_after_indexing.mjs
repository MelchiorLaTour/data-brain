// A file that was indexed while it was on this Mac and LATER becomes online-only (macOS offloads it: 3 -> 39 -> 147 files on a real Mac) must
//   - stay searchable (its search row is kept, not rebuilt empty), and must not be pruned as missing;
//   - be counted as "N indexed file(s) ... now cloud-only on this Mac (still searchable)", not as a gap;
//   - never be opened by a read or by read-time freshness (opening it downloads it): the answer is the text indexed earlier, even if the
//     file's bytes changed since. Online-only files are simulated with NB_TEST_DATALESS_LIST (the engine's own test hook).
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-cloudafter-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents');
await fs.mkdir(docs, { recursive: true });
const cloudFile = path.join(docs, 'cloudnote.md');
await fs.writeFile(cloudFile, '# Cloud note\ncloudsoupmarker the soup has 3 carrots and 1 lemon.\n');
await fs.writeFile(path.join(docs, 'plain.md'), '# Plain\nplainmarker an ordinary local note.\n');
const list = path.join(temp, 'dataless.txt'); await fs.writeFile(list, '');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let n = 0;
const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home, NB_TEST_DATALESS_LIST: list, DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const until = async (check, label, limit = 120000) => { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); };
const idle = async () => { await until(async () => { const s = await tool('databrain_setup_status'); return /Stage: ready\./.test(s) && !/(refresh|index housekeeping|app check): running/.test(s); }, 'jobs idle'); await sleep(600); };
try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => /Stage: ready\./.test(await tool('databrain_setup_status')), 'setup reaches ready');
  await idle();
  assert(/cloudnote\.md/.test(await tool('databrain_search', { query: 'cloudsoupmarker' })), 'before: the note is found');

  // the note goes online-only (its date changes, and its bytes change in the cloud copy); then a refresh runs
  await fs.writeFile(list, `${cloudFile}\n`);
  await sleep(1100);
  await fs.chmod(cloudFile, 0o644);   // offloading changes a file's change time, not its text
  await tool('databrain_refresh'); await sleep(1500); await idle();
  // the bytes of the cloud copy change AFTER the last refresh; the on-use check is held off for an hour here, so only a read-time check could notice
  await sleep(1100);
  await fs.writeFile(cloudFile, '# Cloud note\ncloudeditedword the soup now has 3 carrots and 1 lime.\n');

  const found = await tool('databrain_search', { query: 'cloudsoupmarker' });
  assert(/cloudnote\.md/.test(found), `the online-only note is still searchable by its indexed text:\n${found}`);
  assert(!/cloudnote\.md[^\n]*\n[^\n]*edited since it was indexed/.test(found), 'and it is not flagged as edited (going online-only changes a date, not the text)');
  assert(!/cloudnote\.md/.test(await tool('databrain_search', { query: 'cloudeditedword' })), 'the changed bytes were never read');
  const index = await fs.readFile(path.join(home, 'DataBrain', 'moc', 'index.tsv'), 'utf8');
  assert(index.includes('cloudnote.md'), 'its index row was not pruned as missing');
  const status = await tool('databrain_setup_status');
  assert(status.includes('1 indexed file is now cloud-only on this Mac (still searchable).'), `status counts it, in plain words:\n${status.slice(0, 700)}`);
  assert(!/online-only cloud files not downloaded yet/.test(status), 'and does not list it as a gap');

  const hitPath = /^\s*\d+\s+-?[0-9.]+\s+(.+cloudnote\.md)\s*$/m.exec(found)?.[1];
  assert(hitPath, `the hit line has a path:\n${found}`);
  const read = await tool('databrain_read', { path: hitPath });
  assert(/online-only/.test(read) && /cloudsoupmarker/.test(read) && /1 lemon/.test(read), `read answers from the indexed text:\n${read}`);
  assert(!/cloudeditedword|1 lime|Edited after it was indexed/.test(read), `and never opens the file (not the new bytes, no live read):\n${read}`);
  console.log('PASS: an indexed file that later becomes online-only stays searchable, is not pruned, is counted as cloud-only (still searchable), and a read or read-time freshness answers from the indexed text without opening it.');
} finally {
  child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
