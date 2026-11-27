// A source file that changes while relationships are being built ("An indexed source changed while relationships were being built.
// Retry setup.") must never fail setup or ask the user to do anything: the file is read again (bounded tries), and a file that never
// settles is left out of the report and the build still finishes. The test hook DATABRAIN_TEST_RELATIONSHIP_CHANGES makes
// changing.md change under the reader that many times.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-relretry-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 180000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const FAIL_TEXT = /changed while relationships|retry setup|failed/i;

async function scenario(name, changes, expectedStatus) {
  const home = path.join(temp, name);
  const docs = path.join(home, 'Notes');
  await fs.mkdir(docs, { recursive: true });
  const real = await fs.realpath(docs);
  await fs.writeFile(path.join(real, 'steady.md'), '# Steady\nretrymarkersteady stays the same.\n');
  await fs.writeFile(path.join(real, 'changing.md'), '# Changing\nretrymarkerchanging is edited while it is read. See [[steady]].\n');
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', real], {
    env: { ...process.env, HOME: home, DATABRAIN_TEST_RELATIONSHIP_CHANGES: String(changes), DATABRAIN_TEST_RELATIONSHIP_WAIT_MS: '30' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (toolName, args = {}) => (await ask('tools/call', { name: toolName, arguments: args })).result?.content?.[0]?.text ?? '';
  try {
    await ask('initialize', { protocolVersion: '2025-03-26' });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await tool('databrain_setup_start');
    let last = '';
    await until(async () => {
      last = await tool('databrain_setup_status');
      assert(!FAIL_TEXT.test(last.replace(/Extraction exceptions[^\n]*/g, '')), `no failure or "retry setup" text at any point: ${last.slice(0, 600)}`);
      return /Stage: (?:verification pending|ready)\./.test(last);
    }, `${name}: setup reaches verification pending by itself`);
    const report = await fs.readFile(path.join(home, 'DataBrain', 'moc', 'relationships.tsv'), 'utf8');
    const row = report.split('\n').find(line => line.includes('changing.md'));
    assert(row, `changing.md must have a row in the report: ${report}`);
    assert(row.split('\t').includes(expectedStatus), `changing.md must be ${expectedStatus}: ${row}`);
    assert(report.split('\n').find(line => line.includes('steady.md'))?.split('\t').includes('available'), 'the steady file is unaffected');
  } finally { child.kill('SIGKILL'); }
}

try {
  await scenario('twice', 2, 'available');                    // changes twice, settles on the third try: read again, fully included
  await scenario('never', 99, 'changed_while_reading');       // never settles: left out of this report, setup still finishes
  console.log('PASS: a source that changes during the relationship build is re-read by itself (bounded tries); one that never settles is left out and setup still finishes with no retry request.');
} finally {
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
