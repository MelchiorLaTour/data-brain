// Setup cannot be left half done unseen: one setup approval runs indexing by itself, and a manual refresh drops deleted files: while setup waits for
// category labels, status says so; a file deleted in that window loses its index row on databrain_refresh;
// applying the labels builds the relationship report itself and reaches verification.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-setup-finish-')));
const notes = path.join(temp, 'sources', 'notes');
const parent = path.join(temp, 'parent');
const dataHome = path.join(parent, 'DataBrain');
await Promise.all([notes, parent, path.join(temp, 'home')].map(dir => fs.mkdir(dir, { recursive: true })));
await fs.writeFile(path.join(notes, 'codename.md'), '# Codename\nZephyrquill is the lamp prototype.\n');
await fs.writeFile(path.join(notes, 'garden.md'), '# Garden\nTomatoes need staking in June.\n');
await fs.writeFile(path.join(notes, 'bike.md'), '# Bike\nOil the chain every month.\n');

const server = spawn(process.execPath, [serverScript, '--databrain-parent', parent, '--databrain-source-roots', notes], {
  env: { ...process.env, HOME: path.join(temp, 'home') }, stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
server.stderr.setEncoding('utf8'); server.stderr.on('data', part => { stderr += part; });
const replies = new Map();
readline.createInterface({ input: server.stdout }).on('line', line => { const m = JSON.parse(line); replies.get(m.id)?.(m); });
let nextId = 0;
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 30000);
  replies.set(id, m => { clearTimeout(timer); resolve(m); });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, limitMs = 90000) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    assert(Date.now() - start < limitMs, `timed out waiting for ${label}`);
    await sleep(300);
  }
}
const stageIs = stage => async () => (await call('databrain_setup_status')).includes(`Stage: ${stage}`) || null;
const indexRows = async () => (await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8')).split('\n').filter(line => line && !line.startsWith('#'));

try {
  await rpc('initialize', { protocolVersion: '2025-03-26' });
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  // Folders already saved in settings are the approval: status says to start at once, as information, with no question.
  const preStart = await call('databrain_setup_status');
  assert(preStart.startsWith('SETUP NOT STARTED.'), `pre-start status must lead with the banner, got: ${preStart.slice(0, 200)}`);
  assert(/Choosing these in settings is the user's approval\. Call databrain_setup_start now/.test(preStart) && !/confirm/i.test(preStart), `pre-saved settings must not ask for confirmation: ${preStart}`);
  assert(preStart.includes(notes) && preStart.includes(parent), 'the saved paths are shown');
  // One call (setup start) and no databrain_setup_run call: indexing must start by itself.
  await call('databrain_setup_start');
  await waitFor(stageIs('taxonomy pending'), 'indexing to run on its own after setup start');

  const status = await call('databrain_setup_status');
  assert(status.startsWith('SETUP NOT FINISHED. Call databrain_taxonomy_candidates now'), `status must lead with the setup banner, got: ${status.slice(0, 200)}`);

  // a file deleted while setup waits for labels: a manual refresh must drop its row
  await fs.rm(path.join(notes, 'codename.md'));
  assert.equal((await indexRows()).length, 3);
  await call('databrain_refresh');
  await waitFor(async () => (await indexRows()).length === 2 || null, 'deleted row pruned by manual refresh');
  assert(!(await indexRows()).some(line => line.includes('codename.md')));
  await waitFor(stageIs('taxonomy pending'), 'taxonomy pending after refresh');

  // applying the labels finishes the next stage by itself
  const candidates = (await call('databrain_taxonomy_candidates')).split('\n').filter(line => line.startsWith('folder-')).map(line => line.split('\t'));
  await call('databrain_apply_taxonomy', { assignments: candidates.map(cols => ({ folder_id: cols[0], categories: ['notes'] })) });
  const done = await waitFor(stageIs('verification pending'), 'verification pending without a separate relationship call');
  assert(done);
  await fs.stat(path.join(dataHome, 'moc', 'relationships.tsv'));
  const finished = await call('databrain_setup_status');
  assert(!finished.includes('SETUP NOT FINISHED'), 'no banner once setup has moved past labeling');
  // Progress shows a percentage while indexing (state and progress file faked on the finished brain).
  const statePath = path.join(dataHome, '.databrain', 'desktop-state.json');
  const savedState = await fs.readFile(statePath, 'utf8');
  await fs.writeFile(statePath, JSON.stringify({ ...JSON.parse(savedState), stage: 'indexing' }));
  await fs.writeFile(path.join(dataHome, 'moc', 'extract-progress.txt'), '1\n');
  const progress = await call('databrain_setup_status');
  assert(/Extracted about 1 of \d+ files \(\d+%, last update \d+ min ago\)/.test(progress), `progress line must carry a percentage: ${progress}`);
  await fs.writeFile(statePath, savedState);
  await fs.rm(path.join(dataHome, 'moc', 'extract-progress.txt'));

  // Diagnostics: version, stage, counts, recent steps; no home path.
  const manifest = JSON.parse(await fs.readFile(path.join(here, '../mcp/manifest.json'), 'utf8'));
  const diagnostics = await call('databrain_diagnostics');
  assert(diagnostics.includes(`Version: ${manifest.version}`) && diagnostics.includes('Stage: verification pending') && diagnostics.includes('Recent steps'), `diagnostics incomplete: ${diagnostics}`);
  assert(!diagnostics.includes(path.join(temp, 'home')), 'diagnostics must show the home folder as ~');

  // Other launch settings, each in its own server and HOME.
  async function withServer(name, setup, args, run) {
    const home = path.join(temp, name);
    await fs.mkdir(home, { recursive: true });
    await setup?.(home);
    const child = spawn(process.execPath, [serverScript, ...args(home)], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map();
    readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
    let n = 0;
    const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    const tool = async (toolName) => (await ask('tools/call', { name: toolName, arguments: {} })).result.content[0].text;
    try { await ask('initialize', { protocolVersion: '2025-03-26' }); await run({ home, tool }); } finally { child.kill('SIGTERM'); }
  }
  // 1) no folder location set: DataBrain goes in the home folder by itself
  await withServer('home-default', null, home => ['--databrain-source-roots', notes], async ({ home, tool }) => {
    const before = await tool('databrain_setup_status');
    assert(before.startsWith('SETUP NOT STARTED.') && before.includes(`DataBrain parent ${home}`), `default parent must be the home folder: ${before.slice(0, 300)}`);
    await tool('databrain_setup_start');
    await waitFor(async () => (await fs.stat(path.join(home, 'DataBrain', 'moc', 'index.tsv')).catch(() => null)) || null, 'index created under ~/DataBrain');
  });
  // 2) a DataBrain folder already exists there: left untouched, said plainly, no retry loop
  await withServer('home-foreign', async home => {
    await fs.mkdir(path.join(home, 'DataBrain'), { recursive: true });
    await fs.writeFile(path.join(home, 'DataBrain', 'older-brain.txt'), 'not ours\n');
  }, home => ['--databrain-source-roots', notes], async ({ home, tool }) => {
    const status = await tool('databrain_setup_status');
    assert(status.startsWith('SETUP BLOCKED.') && /already exists/.test(status) && /Settings/.test(status), `status must explain the existing folder: ${status.slice(0, 400)}`);
    const started = await tool('databrain_setup_start');
    assert(/already exists/.test(started) && /left it untouched/.test(started) && /different folder/.test(started), `setup start must say what happened and what to do: ${started}`);
    assert.deepEqual(await fs.readdir(path.join(home, 'DataBrain')), ['older-brain.txt'], 'the existing folder must be left exactly as it was');
  });
  // 2b) the existing folder holds links (a project folder with a moc link): still "already exists", never "unreadable"
  await withServer('home-foreign-links', async home => {
    await fs.mkdir(path.join(home, 'DataBrain', 'elsewhere'), { recursive: true });
    await fs.symlink(path.join(home, 'DataBrain', 'elsewhere'), path.join(home, 'DataBrain', 'moc'));
  }, home => ['--databrain-source-roots', notes], async ({ home, tool }) => {
    const status = await tool('databrain_setup_status');
    assert(status.startsWith('SETUP BLOCKED.') && /already exists/.test(status) && !/unreadable/.test(status), `a folder with links must be explained as already existing: ${status.slice(0, 400)}`);
    const started = await tool('databrain_setup_start');
    assert(/already exists/.test(started) && !/unreadable/.test(started), `setup start must say it already exists: ${started}`);
  });
  // 3) settings not saved at all: the approval question stays
  await withServer('unsaved', null, () => [], async ({ tool }) => {
    const bareStatus = await tool('databrain_setup_status');
    assert(!bareStatus.startsWith('SETUP NOT STARTED.') && /explicitly confirms/.test(bareStatus), `unsaved settings must keep the approval question: ${bareStatus}`);
  });
  console.log('PASS: setup defaults to ~/DataBrain, leaves an existing folder alone and says so, shows progress as a percentage, has diagnostics, pre-saved settings start setup with no question, status says when setup is unfinished, manual refresh prunes deleted files, and applying labels builds the relationship report itself');
} catch (error) {
  throw new Error(`${error.message}${stderr ? `\nMCP stderr: ${stderr.slice(0, 1500)}` : ''}`);
} finally {
  server.kill('SIGTERM');
  await fs.rm(temp, { recursive: true, force: true });
}
