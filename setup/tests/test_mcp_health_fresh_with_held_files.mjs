// A client must not be told "stale" right after a refresh when nothing changed (0.1.26 real Mac: the audit flagged the index as stale although
// the refresh had just finished). Files held back for privacy are not indexed on purpose, so they are not "new files waiting for a refresh":
// the health report and the install audit must count them the way the on-use check does.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-healthheld-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents');
await fs.mkdir(docs, { recursive: true });
await fs.writeFile(path.join(docs, 'garden.md'), '# Garden\nhealthheldmarker tomatoes need staking in June.\n');
await fs.writeFile(path.join(docs, 'payslip-march.md'), 'private by its name\n');
await fs.writeFile(path.join(docs, 'scan0042.md'), '# Misc\npay to FR7630006000011234567890189 please\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let n = 0;
const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  for (const t0 = Date.now(); ;) {
    const status = await tool('databrain_setup_status');
    if (/Stage: (?:verification pending|ready)\./.test(status)) break;
    if (/held back|looks private|privacy/i.test(status) && !/Stage: (?:verification pending|ready)/.test(status)) await tool('databrain_privacy', { action: 'decide', keep: [] });
    assert(Date.now() - t0 < 120000, 'setup finishes'); await sleep(400);
  }
  await sleep(1500);
  const health = await tool('databrain_health');
  assert(/Source freshness: current\./.test(health), `held-back files do not make the index look stale right after a refresh:\n${health}`);
  assert(!/The check reported an issue/.test(health), `and the health report raises no issue:\n${health}`);
  const audit = await tool('databrain_verify_install');
  const line = audit.split('\n').find(l => /Selected-source health/.test(l)) || '';
  assert(/freshness current/.test(line), `the install audit says freshness is current:\n${line}`);
  console.log('PASS: with files held back for privacy, the health report and the install audit say freshness is current right after a refresh.');
} finally {
  child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
