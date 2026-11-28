// A first-run job that fails is retried with growing waits, at most 5 tries in all. Then it stops for good, says plainly what failed and what
// to do, and says so in the status (no notification banner). Before the cap it was resumed every ~15 seconds forever.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-cap-')));
const home = path.join(temp, 'home');
const docs = path.join(home, 'Notes');
await fs.mkdir(docs, { recursive: true });
const real = await fs.realpath(docs);
await fs.writeFile(path.join(real, 'a-note.md'), '# A\ncapmarker text.\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(200)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const stub = path.join(temp, 'osascript-stub.sh'); const log = path.join(temp, 'notify.log');
await fs.writeFile(stub, '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$NOTIFY_LOG"\n', { mode: 0o755 });
const dataHome = path.join(home, 'DataBrain');
const starts = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(line => /initial indexing\t[0-9a-f]+\tjob-start/.test(line)).length;

const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', real], { env: { ...process.env, HOME: home, NOTIFY_LOG: log, DATABRAIN_TEST_OSASCRIPT: stub, DATABRAIN_TEST_FAIL_JOB: 'initial indexing', DATABRAIN_TEST_RETRY_BASE_MS: '100' }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
let n = 0;
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
try {
  await ask('initialize', { protocolVersion: '2025-03-26' });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  let status = '';
  await until(async () => { status = await tool('databrain_setup_status'); return /DataBrain stopped after 5 tries/.test(status); }, 'the 5th failure stops the retries');
  assert(/the indexing run failed each time\. Nothing was lost\./.test(status) && !/databrain_setup_run/.test(status), `plain line saying what failed (what to do is in the tool description):\n${status}`);
  assert(!/Private-Report|\.pdf|\/Users/.test(status.split('\n').filter(line => /stopped after/.test(line)).join('\n')), 'the line names no file');
  assert.equal(await starts(), 5, 'exactly 5 tries were made');
  await sleep(2500);
  assert.equal(await starts(), 5, 'no 6th try after the cap');
  const sent = (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  assert.equal(sent.length, 0, `no notification banner: ${sent.join(' | ')}`);
  // a manual retry starts a new run (and the count starts again)
  await tool('databrain_setup_run');
  await until(async () => (await starts()) === 6, 'a manual retry runs once more');
  console.log('PASS: a failing first-run job gets 5 tries with growing waits, then stops with a plain status line and no notification; a manual retry runs again.');
} finally {
  child.kill('SIGKILL');
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
