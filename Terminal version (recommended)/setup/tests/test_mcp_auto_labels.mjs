// Setup must finish with nobody in the chat: after setup start, only status checks, and the stage still
// reaches "verification pending" with every folder group labelled from its own folder name.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-auto-labels-')));
const home = path.join(temp, 'home');
const docs = path.join(home, 'Documents');
await fs.mkdir(path.join(docs, 'Garden Plans'), { recursive: true });
await fs.mkdir(path.join(docs, '2026 Trips'), { recursive: true });
await fs.writeFile(path.join(docs, 'top.md'), '# Top\nautolabeltop sample note.\n');
await fs.writeFile(path.join(docs, 'Garden Plans', 'beds.md'), '# Beds\nautolabelbeds raised bed plan.\n');
await fs.writeFile(path.join(docs, '2026 Trips', 'lisbon.md'), '# Lisbon\nautolabellisbon trip.\n');

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const server = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
const replies = new Map();
readline.createInterface({ input: server.stdout }).on('line', line => { const m = JSON.parse(line); replies.get(m.id)?.(m); });
let nextId = 0;
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 60000);
  replies.set(id, m => { clearTimeout(timer); resolve(m); });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const toolCalls = [];

try {
  await rpc('initialize', { protocolVersion: '2025-03-26' });
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  toolCalls.push('databrain_setup_start');
  await call('databrain_setup_start');
  let status = '';
  const start = Date.now();
  for (;;) {
    toolCalls.push('databrain_setup_status');
    status = await call('databrain_setup_status');          // the only call made while waiting
    if (/Stage: (?:verification pending|ready)\./.test(status)) break;
    assert(Date.now() - start < 120000, `timed out; last status: ${status.slice(0, 500)}`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert(toolCalls.every(name => ['databrain_setup_start', 'databrain_setup_status'].includes(name)), 'no other tool call may be needed');
  const rows = (await fs.readFile(path.join(home, 'DataBrain', 'moc', 'index.tsv'), 'utf8')).split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
  const themeOf = file => rows.find(row => row[0].endsWith(file))?.[2];
  assert.equal(themeOf('top.md'), 'documents', 'a file directly in the root takes the root folder name');
  assert.equal(themeOf('beds.md'), 'garden-plans', 'a subfolder is labelled from its own name, lowercase');
  assert.equal(themeOf('lisbon.md'), 'f-2026-trips', 'a name that starts with a digit gets a safe label');
  await fs.stat(path.join(home, 'DataBrain', 'moc', 'relationships.tsv'));
  console.log('PASS: indexing finishes, labels come from folder names and the relationship report is built with no tool call but status checks; stage reaches verification pending.');

  // A brain left at "taxonomy pending" (older version, or a restart mid-way) finishes itself on the next status check.
  const home2 = path.join(temp, 'home2');
  await fs.mkdir(path.join(home2), { recursive: true });
  const docs2 = path.join(home2, 'Documents');
  await fs.mkdir(path.join(docs2, 'Notes'), { recursive: true });
  await fs.writeFile(path.join(docs2, 'Notes', 'one.md'), '# One\nresumemarker one.\n');
  async function session(env, run, roots = [docs2]) {
    const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home2, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map();
    readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
    let n = 0;
    const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    const tool = async name => (await ask('tools/call', { name, arguments: {} })).result?.content?.[0]?.text ?? '';
    try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool); } finally { child.kill('SIGTERM'); }
  }
  await session({ DATABRAIN_TEST_NO_AUTO_LABELS: '1' }, async tool => {
    await tool('databrain_setup_start');
    for (const t0 = Date.now(); !(await tool('databrain_setup_status')).includes('Stage: taxonomy pending'); await new Promise(r => setTimeout(r, 300))) assert(Date.now() - t0 < 120000, 'first session never reached taxonomy pending');
  });
  await session({ DATABRAIN_TEST_NO_AUTO_LABELS: '' }, async tool => {
    for (const t0 = Date.now(); !/Stage: (?:verification pending|ready)\./.test((await tool('databrain_setup_status'))); await new Promise(r => setTimeout(r, 300))) assert(Date.now() - t0 < 120000, 'a stuck taxonomy pending brain did not finish by itself');
  });
  console.log('PASS: a brain left at taxonomy pending finishes itself on a later status check.');

  // Folders added in settings are picked up by themselves (indexed, labelled); folders removed are dropped. No reconcile step.
  const docs3 = path.join(home2, 'Desktop');
  await fs.mkdir(docs3, { recursive: true });
  await fs.writeFile(path.join(docs3, 'extra.md'), '# Extra\nsyncaddedmarker new folder note.\n');
  const indexText = () => fs.readFile(path.join(home2, 'DataBrain', 'moc', 'index.tsv'), 'utf8');
  const until = async (check, label) => { for (const t0 = Date.now(); !(await check()); await new Promise(r => setTimeout(r, 300))) assert(Date.now() - t0 < 120000, label); };
  await session({ DATABRAIN_TEST_NO_AUTO_LABELS: '' }, async tool => {
    await tool('databrain_setup_status');   // the next tool call applies the new folder list
    await until(async () => (await indexText().catch(() => '')).includes('extra.md'), 'a folder added in settings was not indexed by itself');
    await until(async () => /Stage: (?:verification pending|ready)\./.test((await tool('databrain_setup_status'))), 'labelling after adding a folder did not finish');
    assert(!/folder settings changed|reconcile/i.test(await tool('databrain_setup_status')), 'adding a folder must not ask for a reconcile step');
    const search = await tool('databrain_setup_status');
    assert(search.includes('Selected source folders: 2'), search.slice(0, 300));
  }, [docs2, docs3]);
  await session({ DATABRAIN_TEST_NO_AUTO_LABELS: '' }, async tool => {
    await tool('databrain_setup_status');
    await until(async () => !(await indexText()).includes('extra.md'), 'a folder removed in settings was not dropped');
    assert((await indexText()).includes('one.md'), 'the remaining folder stays indexed');
    assert((await tool('databrain_setup_status')).includes('Selected source folders: 1'));
  }, [docs2]);
  console.log('PASS: folders added or removed in settings take effect by themselves, with no reconcile step.');
} finally {
  server.kill();
  await fs.rm(temp, { recursive: true, force: true });
}
