// A restart can give a disk a new st_dev while the folder is the same (same inode, same real path). 0.1.45 compared dev and ino, so every
// read said "An approved source folder changed identity" and re-selecting kept the stale dev. This test fakes the renumber with invented
// folders (stored dev wrong, ino right) and checks: (a) reads work, (b) re-approval refreshes the record, (c) a brain stuck on 0.1.45 recovers
// by itself, and (d) a REPLACED folder (different inode) is still refused.
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const engine = path.resolve(process.argv[2] || path.resolve(here, '../..'));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-renumber-')));
const home = path.join(temp, 'home');

function startServer(parent, roots, extraEnv = {}) {
  const server = spawn(process.execPath, [serverScript, '--databrain-parent', parent, '--databrain-source-roots', ...roots],
    { env: { ...process.env, HOME: home, DATABRAIN_TEST_STEP_BY_STEP: '1', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  readline.createInterface({ input: server.stdout }).on('line', line => { const message = JSON.parse(line); replies.get(message.id)?.(message); });
  server.stderr.resume();
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 20000);
    replies.set(requestId, message => { clearTimeout(timer); replies.delete(requestId); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  const call = async (name, args = {}) => (await request('tools/call', { name, arguments: args })).result.content[0].text;
  const stop = async () => { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve)); };
  return { request, call, stop, ready: async () => { await request('initialize', { protocolVersion: '2025-03-26' }); server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); } };
}

async function waitFor(call, tool, phrase) {
  let text = '';
  for (let i = 0; i < 400; i += 1) {
    text = await call(tool);
    if (text.includes(phrase)) return text;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${phrase}: ${text}`);
}

const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse);

try {
  await fs.mkdir(home, { recursive: true });
  const parent = path.join(temp, 'parent');
  const srcA = path.join(temp, 'Source A');
  const srcB = path.join(temp, 'Source B');
  await Promise.all([parent, srcA, srcB].map(dir => fs.mkdir(dir, { recursive: true })));
  const canonicalParent = await fs.realpath(parent);
  const [A, B] = await Promise.all([fs.realpath(srcA), fs.realpath(srcB)]);
  const fileA = path.join(A, 'renumber-a.md');
  const fileB = path.join(B, 'renumber-b.md');
  await fs.writeFile(fileA, '# Note A\nrenumberalphamarker\n');
  await fs.writeFile(fileB, '# Note B\nrenumberbetamarker\n');
  const dataHome = path.join(canonicalParent, 'DataBrain');
  const statePath = path.join(dataHome, '.databrain', 'desktop-state.json');
  const tsvPath = path.join(dataHome, '.databrain', 'root-identities.tsv');
  const realDev = root => lstatSync(root).dev;
  const realIno = root => lstatSync(root).ino;

  // Set up a brain the normal way, then seed a small index (same recipe as test_mcp_desktop_settings.mjs).
  const setup = startServer(canonicalParent, [A, B]);
  try {
    await setup.ready();
    assert((await setup.call('databrain_setup_start')).includes('Creating DataBrain'));
    await waitFor(setup.call, 'databrain_setup_status', 'Stage: sources selected');
  } finally { await setup.stop(); }
  const moc = path.join(dataHome, 'moc');
  await fs.mkdir(moc, { recursive: true });
  await fs.writeFile(path.join(moc, 'index.tsv'), `${fileA}\tNote A\ttest\trenumberalphamarker\n${fileB}\tNote B\ttest\trenumberbetamarker\n`);
  const built = spawnSync('/bin/bash', [path.join(engine, 'bin/build-fts.sh')], {
    env: { ...process.env, HOME: home, NB_MOC_DIR: moc, NB_CANON_ROOTS_FILE: path.join(dataHome, '.source-roots') }, encoding: 'utf8' });
  assert.equal(built.status, 0, `could not seed the disposable search database: ${built.stderr}`);

  // The 0.1.45 stuck state: the saved dev is wrong, the inode is right, in the state file AND in the tsv the shell scripts read.
  async function makeStuck() {
    const state = await readJson(statePath);
    state.rootIdentities = state.rootIdentities.map(entry => ({ ...entry, dev: entry.dev + 2 }));
    await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await fs.writeFile(tsvPath, state.rootIdentities.map(({ path: root, dev, ino }) => `${root}\t${dev}:${ino}`).join('\n') + '\n');
    return state.rootIdentities;
  }
  const expectFresh = async label => {
    const state = await readJson(statePath);
    for (const entry of state.rootIdentities) {
      assert.equal(entry.dev, realDev(entry.path), `${label}: ${entry.path} must carry the real dev again`);
      assert.equal(entry.ino, realIno(entry.path), `${label}: inode unchanged`);
    }
    assert.equal(await fs.readFile(tsvPath, 'utf8'), state.rootIdentities.map(({ path: root, dev, ino }) => `${root}\t${dev}:${ino}`).join('\n') + '\n', `${label}: the tsv grant must match the state`);
  };

  // (a) + (c): a brain stuck on 0.1.45 reads again after the upgrade with no user action, and the records are refreshed.
  await makeStuck();
  const upgraded = startServer(canonicalParent, [A, B]);
  try {
    await upgraded.ready();
    const search = await upgraded.call('databrain_search', { query: 'renumberalphamarker' });
    assert(!search.includes('changed identity'), `a renumbered disk must not lock reads out: ${search}`);
    assert(search.includes('renumber-a.md'), search);
    const read = await upgraded.call('databrain_read', { path: fileA });
    assert(read.includes('renumberalphamarker'), `read must work after the renumber: ${read}`);
    await expectFresh('stuck 0.1.45 state after upgrade');
  } finally { await upgraded.stop(); }

  // (b): with the automatic refresh switched off, re-approving (select sources, and a settings change that drops a folder) still re-captures.
  const staleBefore = await makeStuck();
  const reapprove = startServer(canonicalParent, [A, B], { DATABRAIN_TEST_NO_RENUMBER_HEAL: '1' });
  try {
    await reapprove.ready();
    const job = await reapprove.call('databrain_select_sources');
    assert(job.includes('Reconciliation job:'), job);
    await waitFor(reapprove.call, 'databrain_setup_status', 'source grant reconciliation: complete');
    await expectFresh('re-approval through select sources');
  } finally { await reapprove.stop(); }
  assert.notEqual(staleBefore[0].dev, realDev(A), 'sanity: the fake record was stale');

  await makeStuck();
  const dropOne = startServer(canonicalParent, [B], { DATABRAIN_TEST_NO_RENUMBER_HEAL: '1' });
  try {
    await dropOne.ready();
    await dropOne.call('databrain_search', { query: 'renumberbetamarker' });   // a tool call applies the settings change by itself
    const state = await readJson(statePath);
    assert.deepEqual(state.roots, [B]);
    assert.equal(state.rootIdentities.find(entry => entry.path === B).dev, realDev(B), 'the kept folder must be re-captured, not carried over stale');
  } finally { await dropOne.stop(); }

  // (d) strict: a different inode at the same path is still refused, and the record is NOT refreshed to bless it.
  const strictParent = path.join(temp, 'strict parent');
  const strictSrc = path.join(temp, 'Strict source');
  await fs.mkdir(strictParent); await fs.mkdir(strictSrc);
  const strictRoot = await fs.realpath(strictSrc);
  await fs.writeFile(path.join(strictRoot, 'original.md'), '# O\noriginalstrictmarker\n');
  const strict = startServer(await fs.realpath(strictParent), [strictRoot]);
  try {
    await strict.ready();
    await strict.call('databrain_setup_start');
    await waitFor(strict.call, 'databrain_setup_status', 'Stage: sources selected');
  } finally { await strict.stop(); }
  await fs.rename(strictRoot, `${strictRoot}.original`);
  await fs.mkdir(strictRoot);
  await fs.writeFile(path.join(strictRoot, 'replacement.md'), '# R\nreplacementstrictsecret\n');
  const strictState = path.join(await fs.realpath(strictParent), 'DataBrain', '.databrain', 'desktop-state.json');
  // Worst case for the refresh rule: the replacement has a new inode AND the saved dev is also off. It must still be refused.
  const strictTsv = path.join(path.dirname(strictState), 'root-identities.tsv');
  const strictSaved = await readJson(strictState);
  strictSaved.rootIdentities[0].dev += 2;
  await fs.writeFile(strictState, `${JSON.stringify(strictSaved, null, 2)}\n`);
  await fs.writeFile(strictTsv, `${strictSaved.rootIdentities[0].path}\t${strictSaved.rootIdentities[0].dev}:${strictSaved.rootIdentities[0].ino}\n`);
  const savedIno = strictSaved.rootIdentities[0].ino;
  const replaced = startServer(await fs.realpath(strictParent), [strictRoot]);
  try {
    await replaced.ready();
    const denied = await replaced.call('databrain_search', { query: 'replacementstrictsecret' });
    assert(denied.includes('changed identity'), denied);
    assert(!denied.includes('replacementstrictsecret'), 'a replacement folder must not be searchable under the old approval');
    assert.equal((await readJson(strictState)).rootIdentities[0].ino, savedIno, 'the saved record must stay bound to the original folder');
  } finally { await replaced.stop(); }

  console.log('PASS: a renumbered disk (same inode, new dev) does not lock out reads; a brain stuck on 0.1.45 recovers by itself (state and tsv refreshed); re-approval re-captures the record; a replaced folder (new inode) is still refused.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
