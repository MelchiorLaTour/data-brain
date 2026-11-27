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
process.env.DATABRAIN_TEST_NO_AUTO_LABELS = '1';   // this test walks the manual labelling steps; test_mcp_auto_labels.mjs covers the automatic finish

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
  assert(/Choosing these in settings is the user's approval\./.test(preStart) && !/confirm/i.test(preStart) && !/databrain_setup_start/.test(preStart), `pre-saved settings must not ask for confirmation: ${preStart}`);
  assert(preStart.includes(notes) && preStart.includes(parent), 'the saved paths are shown');
  // One call (setup start) and no databrain_setup_run call: indexing must start by itself.
  await call('databrain_setup_start');
  await waitFor(stageIs('taxonomy pending'), 'indexing to run on its own after setup start');

  const status = await call('databrain_setup_status');
  assert(status.startsWith('SETUP NOT FINISHED. The folder groups are not labelled yet.'), `status must lead with the setup banner, got: ${status.slice(0, 200)}`);

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
  // 2) ~/DataBrain already exists and is not ours: left untouched, the brain goes in ~/DataBrain 2 and chat is told where
  await withServer('home-foreign', async home => {
    await fs.mkdir(path.join(home, 'DataBrain'), { recursive: true });
    await fs.writeFile(path.join(home, 'DataBrain', 'older-brain.txt'), 'not ours\n');
  }, home => ['--databrain-source-roots', notes], async ({ home, tool }) => {
    const status = await tool('databrain_setup_status');
    assert(status.startsWith('SETUP NOT STARTED.') && !/already exists/.test(status), `an existing folder must not block setup: ${status.slice(0, 300)}`);
    await tool('databrain_setup_start');
    await waitFor(async () => (await fs.stat(path.join(home, 'DataBrain 2', 'moc', 'index.tsv')).catch(() => null)) || null, 'index created under ~/DataBrain 2');
    assert.deepEqual(await fs.readdir(path.join(home, 'DataBrain')), ['older-brain.txt'], 'the existing folder must be left exactly as it was');
    const after = await tool('databrain_setup_status');
    assert(after.includes('Stage:') && !/unreadable|SETUP BLOCKED/.test(after), after.slice(0, 300));
    assert(after.includes(`Created your DataBrain at ${path.join(home, 'DataBrain 2')}`) && /DataBrain 2/.test(after), `status must say exactly where the brain was created: ${after.slice(-400)}`);
  });
  // 2b) the existing ~/DataBrain holds links (a project folder with a moc link): same result, never "unreadable"
  await withServer('home-foreign-links', async home => {
    await fs.mkdir(path.join(home, 'DataBrain', 'elsewhere'), { recursive: true });
    await fs.symlink(path.join(home, 'DataBrain', 'elsewhere'), path.join(home, 'DataBrain', 'moc'));
  }, home => ['--databrain-source-roots', notes], async ({ home, tool }) => {
    const status = await tool('databrain_setup_status');
    assert(!/unreadable|SETUP BLOCKED/.test(status), `a folder with links must not break status: ${status.slice(0, 300)}`);
    const started = await tool('databrain_setup_start');
    assert(!/unreadable/.test(started), started);
    await waitFor(async () => (await fs.stat(path.join(home, 'DataBrain 2', 'moc', 'index.tsv')).catch(() => null)) || null, 'index created under ~/DataBrain 2');
  });
  // 2c) Desktop as a read folder with the brain in the home folder works; the chat is told exactly where it was created
  await withServer('desktop-source', async home => {
    await fs.mkdir(path.join(home, 'Desktop', 'Databrain'), { recursive: true });
    await fs.writeFile(path.join(home, 'Desktop', 'plain.md'), '# Plain\nDesktopmarker text.\n');
  }, home => ['--databrain-source-roots', path.join(home, 'Desktop')], async ({ home, tool }) => {
    const started = await tool('databrain_setup_start');
    assert(started.includes('Creating your DataBrain at') || started.includes('Creating DataBrain'), started);
    await waitFor(async () => (await fs.stat(path.join(home, 'DataBrain', 'moc', 'index.tsv')).catch(() => null)) || null, 'Desktop indexed with the brain in the home folder');
    assert((await fs.readFile(path.join(home, 'DataBrain', 'moc', 'index.tsv'), 'utf8')).includes('plain.md'));
  });
  // 2d) an install that saved an older folder-location setting keeps its brain there
  await withServer('legacy-location', async home => {
    const legacyParent = path.join(home, 'OldPlace');
    await fs.mkdir(path.join(legacyParent, 'DataBrain', '.databrain'), { recursive: true });
    await fs.writeFile(path.join(legacyParent, 'DataBrain', '.databrain', 'desktop-state.json'), JSON.stringify({ stage: 'ready', destinationParent: legacyParent, roots: [], rootIdentities: [], createdAt: new Date().toISOString() }));
    const dir = path.join(home, 'Library', 'Application Support', 'Claude', 'Claude Extensions Settings');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'local.mcpb.melchior-la-tour.databrain.json'), JSON.stringify({ isEnabled: true, userConfig: { data_parent: legacyParent, source_roots: [notes] } }));
  }, home => ['--databrain-source-roots', notes], async ({ home, tool }) => {
    const status = await tool('databrain_setup_status');
    // found at its saved location (its folder list differs from the settings, so it also starts applying them by itself)
    assert(/Stage: (ready|indexing|taxonomy pending|verification pending)/.test(status), `an existing brain at its saved location must be found: ${status.slice(0, 300)}`);
    await assert.rejects(fs.stat(path.join(home, 'DataBrain')), { code: 'ENOENT' }, 'no new brain may be created next to the existing one');
    await assert.rejects(fs.stat(path.join(home, 'DataBrain 2')), { code: 'ENOENT' }, 'no numbered brain either');
  });
  // 3) settings not saved at all: the approval question stays
  await withServer('unsaved', null, () => [], async ({ tool }) => {
    const bareStatus = await tool('databrain_setup_status');
    assert(!bareStatus.startsWith('SETUP NOT STARTED.') && /No source folders are saved in Claude Desktop extension settings/.test(bareStatus), `unsaved settings are stated as a fact: ${bareStatus}`);
  });
  console.log('PASS: setup defaults to ~/DataBrain, leaves an existing folder alone and says so, shows progress as a percentage, has diagnostics, pre-saved settings start setup with no question, status says when setup is unfinished, manual refresh prunes deleted files, and applying labels builds the relationship report itself');
} catch (error) {
  throw new Error(`${error.message}${stderr ? `\nMCP stderr: ${stderr.slice(0, 1500)}` : ''}`);
} finally {
  server.kill('SIGTERM');
  await fs.rm(temp, { recursive: true, force: true });
}
