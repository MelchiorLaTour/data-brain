// (1) Identical files show once in search and abstain_check results, with "also in N other places", so 338 duplicate groups cannot
// crowd out other answers. (2) Status and diagnostics say WHY supported files are not indexed: counts only, never a file name.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-dups-')));
const home = path.join(temp, 'home');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 240000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const root = path.join(home, 'Notes');
await fs.mkdir(root, { recursive: true });
const real = await fs.realpath(root);
// 5 files with identical content in 5 folders (the same file saved in several places) plus 3 different notes about the same topic
for (let i = 1; i <= 5; i += 1) {
  await fs.mkdir(path.join(real, `copy${i}`), { recursive: true });
  await fs.writeFile(path.join(real, `copy${i}`, 'budget.md'), '# Budget\nzephyrquill budget zephyrquill plan zephyrquill figures for the year.\n');
}
for (const name of ['alpha', 'beta', 'gamma']) await fs.writeFile(path.join(real, `${name}-other.md`), `# ${name}\nzephyrquill mentioned once in the ${name} note about something else entirely.\n`);
// reasons: an unreadable file (one such file used to abort the whole index), a private-looking file; an empty file is still indexed
await fs.writeFile(path.join(real, 'blank-sheet.md'), '');
await fs.writeFile(path.join(real, 'locked-notes.md'), '# Locked\nsecretive text\n'); await fs.chmod(path.join(real, 'locked-notes.md'), 0o000);
await fs.writeFile(path.join(real, 'payslip-march.md'), '# Pay\nprivatemarker\n');

const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', real], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
let n = 0;
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const hitLines = text => text.split('\n').filter(line => /^\s*\d+\s+-?[0-9]+(?:\.[0-9]+)?\s+\S/.test(line));
try {
  await ask('initialize', { protocolVersion: '2025-03-26' });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  let first = await tool('databrain_setup_start');
  await until(async () => { first = await tool('databrain_setup_status'); return /SETUP PAUSED FOR PRIVACY REVIEW/.test(first) || /Stage: (?:verification pending|ready)\./.test(first); }, 'the privacy pause or the finish');
  if (/SETUP PAUSED FOR PRIVACY REVIEW/.test(first)) { await tool('databrain_privacy', { action: 'list' }); await tool('databrain_privacy', { action: 'decide', keep: [] }); }
  let last = '';
  await until(async () => { last = await tool('databrain_setup_status'); return /Stage: (?:verification pending|ready)\./.test(last); }, 'setup finished').catch(error => { throw new Error(`${error.message}\n${last.slice(0, 5000)}`); });

  // (1) duplicates collapse
  const found = await tool('databrain_search', { query: 'zephyrquill', limit: 8 });
  const hits = hitLines(found);
  const budgetHits = hits.filter(line => line.includes('budget.md'));
  assert.equal(budgetHits.length, 1, `the 5 identical budget.md files must show once:\n${found}`);
  assert(/also in 4 other places \(identical content\)/.test(found), `the single copy says how many other places hold the same content:\n${found}`);
  for (const name of ['alpha', 'beta', 'gamma']) assert(found.includes(`${name}-other.md`), `${name}-other.md must not be crowded out:\n${found}`);
  assert.equal(hits.length, 4, `4 distinct results (1 budget + 3 others), not 8 with copies:\n${found}`);
  const abstain = await tool('databrain_abstain_check', { queries: ['zephyrquill budget', 'zephyrquill figures'] });
  assert.equal(hitLines(abstain).filter(line => line.includes('budget.md')).length, 2, 'abstain_check shows the copy once per variant, not three times');
  const read = await tool('databrain_read', { path: hits[0].replace(/^\s*\d+\s+-?[0-9.]+\s+/, '') });
  assert(/Evidence from:/.test(read), `a shown result can still be read: ${read.slice(0, 200)}`);

  // (2) why files are not indexed: counts only
  const status = await tool('databrain_setup_status');
  const diagnostics = await tool('databrain_diagnostics');
  for (const [label, text] of [['status', status], ['diagnostics', diagnostics]]) {
    const line = text.split('\n').find(l => l.startsWith('Supported files not indexed:'));
    assert(line, `${label} must say why supported files are not indexed:\n${text.slice(0, 1500)}`);
    assert(/1 could not be read \(macOS blocked access\)/.test(line) && !/held back for privacy/.test(line), `${label} reasons with counts, and the privacy count is only in its own labelled line: ${line}`);
    if (label === 'status') assert(/^Held back for privacy: /m.test(text), `status has the one labelled privacy line:\n${text.slice(0, 1500)}`);
    for (const name of ['blank-sheet', 'locked-notes', 'payslip', 'budget']) assert(!line.includes(name), `${label} must not name files: ${line}`);
  }
  console.log('PASS: identical files show once with "also in N other places" (search and abstain_check, still readable), and status and diagnostics say why supported files are not indexed, with counts and no names.');
} finally {
  child.kill('SIGKILL');
  await fs.chmod(path.join(real, 'locked-notes.md'), 0o600).catch(() => {});
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
