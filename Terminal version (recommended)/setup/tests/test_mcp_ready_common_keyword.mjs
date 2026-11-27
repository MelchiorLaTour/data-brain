// The known-hit check behind 'ready' must ask a question only the checked record can answer. On Mel's real brain the first record's
// keyword ("resume") was shared by 86 rows and search returns only 8, so the check failed and 'ready' was never reached.
// Fixture: the first record's top keyword is shared by 12 rows (more than the 8 results), and its own rank is below the cut.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-common-')));
const home = path.join(temp, 'home');
const docs = path.join(home, 'Notes');
await fs.mkdir(docs, { recursive: true });
const real = await fs.realpath(docs);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 240000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

// 12 notes. The word "resumeword" is each note's top keyword. The first note says it 4 times, the others 8 times, so the first note
// ranks below the 8 results for that word. Every note also has its own rare word (3 times).
for (let i = 1; i <= 12; i += 1) {
  const n = String(i).padStart(2, '0');
  const common = Array(i === 1 ? 4 : 8).fill('resumeword').join(' ');
  await fs.writeFile(path.join(real, `${n}-note.md`), `# Note ${n}\n${common}\nuniqterm${n} uniqterm${n} uniqterm${n}\n`);
}
const dataHome = path.join(home, 'DataBrain');
const stub = path.join(temp, 'osascript-stub.sh');
const log = path.join(temp, 'notify.log');
await fs.writeFile(stub, '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$NOTIFY_LOG"\n', { mode: 0o755 });

const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', real], { env: { ...process.env, HOME: home, NOTIFY_LOG: log, DATABRAIN_TEST_OSASCRIPT: stub }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
let n = 0;
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const savedState = async () => JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'));
try {
  await ask('initialize', { protocolVersion: '2025-03-26' });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => (await savedState().catch(() => ({}))).stage === 'verification pending' || (await savedState().catch(() => ({}))).stage === 'ready', 'the relationship report is built');

  // premise: the OLD check's pick (the first row with a keyword, its first keyword) is shared by more than 8 rows and is not in the top 8
  const rows = (await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8')).split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
  const first = rows.find(row => row[3] && row[3] !== '-');
  const firstKeyword = first[3].split(',')[0].trim();
  assert.equal(firstKeyword, 'resumeword', `fixture premise: the first record's first keyword is the common one: ${first[3]}`);
  assert(rows.filter(row => (row[3] || '').split(',').includes('resumeword')).length > 8, 'fixture premise: the keyword is shared by more than 8 rows');
  const firstPath = first[0].replace(/^~/, home);
  assert(!(await tool('databrain_search', { query: firstKeyword, limit: 8 })).includes(path.basename(firstPath)), `fixture premise: the first record is outside the top 8 for its common keyword (${path.basename(firstPath)})`);

  await until(async () => (await savedState()).stage === 'ready', "the stage reaches 'ready' although the first record's keyword is common");
  assert(/DataBrain is ready\./.test(await tool('databrain_setup_status')), 'the status says ready (there is no notification banner)');
  assert.equal((await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).length, 0, 'no notification was sent');
  const verify = await tool('databrain_verify_install');
  assert(/PASS: Known-hit search\/read/.test(verify), `verify_install shows the known-hit check passing:\n${verify.split('\n').filter(line => /Known-hit/.test(line)).join('\n')}`);
  console.log("PASS: the known-hit check uses the rarest keyword (or exact title) of the most distinctive records, so a brain whose first record has a common keyword (12 rows, 8 results) still reaches 'ready'.");
} finally {
  child.kill('SIGKILL');
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
