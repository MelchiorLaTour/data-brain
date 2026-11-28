// A note can be saved while another job (a long refresh) holds the brain: the file is written at once, the reply says plainly that it becomes
// searchable when the running job ends, and DataBrain then indexes it by itself. Two notes saved during the job are both found afterwards.
// The busy message is in the host's words (no "Claude Desktop" or "extension" in ChatGPT). Runs in either host (DATABRAIN_TEST_CLIENT=chatgpt).
// The long job is simulated by another process holding the exclusive indexing lock, which is exactly what a worker's refresh looks like.
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
const chatgpt = process.env.DATABRAIN_TEST_CLIENT === 'chatgpt';
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-note-busy-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(200)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const home = path.join(temp, 'home');
const docs = path.join(home, 'Documents');
await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plan.md'), '# Plan\nbusynotebase is in this note.\n');
const dataHome = path.join(home, 'DataBrain');
const lockPath = path.join(dataHome, '.databrain', 'index-worker-lock.sqlite');
const statePath = path.join(dataHome, '.databrain', 'desktop-state.json');

async function session(env, run) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realDocs], { env: { ...process.env, HOME: home, DATABRAIN_TEST_NOTE_DRAIN_MS: '400', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => { const reply = await ask('tools/call', { name, arguments: args }); return reply.result?.content?.[0]?.text ?? reply.error?.message ?? ''; };
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool); }
  finally { child.kill('SIGKILL'); }
}
let holder = null;
async function holdLock() {
  holder = spawn('/usr/bin/sqlite3', ['-batch', lockPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  holder.stdout.on('data', part => { out += part; });
  holder.stdin.write("BEGIN EXCLUSIVE;\nSELECT 'HELD';\n");
  await until(async () => out.includes('HELD'), 'the test holds the lock');
}
async function releaseLock() { holder.stdin.end('ROLLBACK;\n.quit\n'); await new Promise(resolve => holder.once('close', resolve)); holder = null; }
const indexText = () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8').catch(() => '');
const noteFiles = async () => (await fs.readdir(realDocs)).filter(name => name.endsWith('.md') && name !== 'plan.md');

try {
  await session({}, async tool => {
    await tool('databrain_setup_start');
    await until(async () => {
      const status = await tool('databrain_setup_status');
      if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await tool('databrain_privacy', { action: 'decide', keep: [] });
      return /Stage: ready\./.test(status);
    }, 'setup reached ready');
  });

  // a long job holds the brain; a note is saved meanwhile
  await holdLock();
  await session({}, async tool => {
    const note = (title, word) => ({ title, body: `An invented note about ${word}.`, keywords: [word, 'busytest'], folder: realDocs });
    const reply = await tool('databrain_capture', note('Busy one', 'zebramarkerone'));
    assert(/Saved the new capture/.test(reply) && /becomes searchable when that job ends/.test(reply), `the reply says it is saved and when it becomes searchable: ${reply}`);
    assert(!/Another DataBrain job is indexing|failed/i.test(reply), reply);
    const files = await noteFiles();
    assert.equal(files.length, 1, 'the note file exists at once');
    assert(!(await indexText()).includes(files[0]), 'not indexed while the other job runs (the index is never touched by two writers)');
    const reply2 = await tool('databrain_capture', note('Busy two', 'zebramarkertwo'));
    assert(/Saved the new capture/.test(reply2), reply2);
    assert.equal((await noteFiles()).length, 2, 'the second note exists at once');
    await releaseLock();
    await until(async () => { const rows = await indexText(); return (await noteFiles()).every(name => rows.includes(name)); }, 'both notes indexed by themselves after the job ends');
    await until(async () => /Stage: ready\./.test(await tool('databrain_setup_status')), 'back to ready');
    for (const word of ['zebramarkerone', 'zebramarkertwo']) assert(new RegExp('Busy (one|two)', 'i').test(await tool('databrain_search', { query: word })), `${word} is found by search`);
    const verify = await tool('databrain_verify_install');
    const bad = verify.split('\n').filter(line => /FAIL/.test(line) && !/GitHub release match/.test(line));
    assert.deepEqual(bad, [], `the index passes verify:\n${verify}`);
  });

  // the busy message is in the host's words
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  await fs.writeFile(statePath, JSON.stringify({ ...state, stage: 'relationships pending' }));
  await holdLock();
  await session({}, async tool => {
    let text = '';
    await until(async () => { text = await tool('databrain_build_relationships') + '\n' + await tool('databrain_setup_status'); return /indexing or changing this brain/.test(text); }, 'the busy message appears');
    assert(/Quitting (ChatGPT or restarting DataBrain|Claude Desktop or restarting the extension) would stop the healthy job/.test(text), text);
    if (chatgpt) assert(!/Claude Desktop|extension/i.test(text.split('\n').filter(line => /indexing or changing/.test(line)).join('\n')), `ChatGPT words only: ${text}`);
    else assert(/Claude Desktop/.test(text), 'the Claude host keeps its own words');
    // the timing log keeps the raw failure text (this is where it was first seen), so it must be in the host's words too
    const log = (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8')).split('\n').filter(line => /indexing or changing this brain/.test(line)).join('\n');
    assert(log, 'the busy failure is logged');
    if (chatgpt) assert(!/Claude Desktop|extension/i.test(log), `ChatGPT words in the log: ${log}`);
    await releaseLock();
  });
  console.log(`PASS (${chatgpt ? 'ChatGPT' : 'Claude'} host): a note saved while a long job runs is written at once, says when it becomes searchable, is indexed by itself afterwards (two notes, verify clean); the busy message uses the host's words.`);
} finally {
  if (holder) holder.kill('SIGKILL');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
