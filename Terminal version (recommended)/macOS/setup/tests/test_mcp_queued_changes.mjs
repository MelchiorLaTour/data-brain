// A folder-list change while indexing is running (or was interrupted when settings were saved) is queued and applied by itself when the
// work ends. Never "restart the extension" or "reconcile". Removed folders are fully pruned. Status always names the running job.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const engineDir = process.env.DATABRAIN_ENGINE_DIR || path.resolve(here, '../..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-queued-')));
const home = path.join(temp, 'home');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 180000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const grepAll = (needle, dir) => spawnSync('/usr/bin/grep', ['-rlaF', needle, dir], { encoding: 'utf8' }).stdout.trim();
const RESTART_WORDS = /restart the extension|restart claude|reconcile|set up databrain again|halted/i;

const folders = {};
for (const name of ['A', 'B', 'C']) {
  folders[name] = path.join(home, `Folder${name}Unique`);
  await fs.mkdir(folders[name], { recursive: true });
  folders[name] = await fs.realpath(folders[name]);
  await fs.writeFile(path.join(folders[name], `note-${name.toLowerCase()}.md`), `# ${name}\nqueuedmarker${name.toLowerCase()} text in folder ${name}.\n`);
}
const dataHome = path.join(home, 'DataBrain');
const indexText = () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');

async function session(roots, env, run) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool, child); }
  finally { child.kill('SIGKILL'); }
}
const orphans = [];
function startOrphan(seconds) {   // an engine step left running by the process that died: its command line holds the engine's bin path
  const child = spawn('/bin/bash', ['-c', `exec -a "$0" /bin/sleep ${seconds}`, path.join(engineDir, 'bin', 'extract.sh')], { stdio: 'ignore' });
  orphans.push(child);
  return child;
}
async function interruptedRefresh(roots) {   // start a refresh, wait until it is running, then kill the process as a settings save would
  await fs.writeFile(path.join(roots[0], `extra-${Date.now()}.md`), '# Extra\nqueuedextra text.\n');
  await session(roots, { DATABRAIN_TEST_INDEX_DELAY_MS: '120000' }, async (tool, child) => {
    await tool('databrain_refresh');
    await until(async () => (await tool('databrain_setup_status')).includes('Stage: indexing'), 'refresh running');
    const status = await tool('databrain_setup_status');
    assert(/Running now: refresh, job ID [0-9a-f-]{36}/.test(status) && /refresh: running — .*\(job ID [0-9a-f-]{36}\)/.test(status), `status must name the running job and its ID: ${status.slice(0, 600)}`);
    child.kill('SIGKILL');
  });
}

try {
  // brain set up with A and B
  await session([folders.A, folders.B], {}, async tool => {
    await tool('databrain_setup_start');
    await until(async () => /Stage: (?:verification pending|ready)\./.test((await tool('databrain_setup_status'))), 'setup finished');
    assert(grepAll('queuedmarkerb', dataHome) !== '');
  });

  // 1) interrupted mid-refresh, nothing left running; folders become A and C
  await interruptedRefresh([folders.A, folders.B]);
  await session([folders.A, folders.C], {}, async tool => {
    const first = await tool('databrain_setup_status');
    assert(!RESTART_WORDS.test(first), `no restart or reconcile text: ${first}`);
    await until(async () => { const text = await tool('databrain_setup_status'); assert(!RESTART_WORDS.test(text), `no restart or reconcile text: ${text}`); return /Stage: (?:verification pending|ready)\./.test(text) && (await indexText()).includes('note-c.md') && !(await indexText()).includes('note-b.md') && text.includes('Selected source folders: 2'); }, 'the change applied by itself after the interrupted work');
    for (const leftover of ['queuedmarkerb', 'note-b.md', 'FolderBUnique']) assert.equal(grepAll(leftover, dataHome), '', `"${leftover}" from the removed folder must be gone everywhere`);
    assert(grepAll('queuedmarkerc', dataHome) !== '', 'the added folder is indexed');
  });

  // 2) interrupted again, and an engine step from the dead process is still running: queued, said plainly, applied when it ends; folders A and B again
  await interruptedRefresh([folders.A, folders.C]);
  const orphan = startOrphan(12);
  await session([folders.A, folders.B], {}, async tool => {
    await sleep(500);
    const status = await tool('databrain_setup_status');
    assert(/Indexing from before the extension restarted is still running/.test(status), `status must say the earlier indexing is still running: ${status.slice(0, 600)}`);
    assert(/Indexing is running; your folder change will apply when it finishes/.test(status), `status must say the change is queued: ${status.slice(0, 600)}`);
    assert(!RESTART_WORDS.test(status), `no restart or reconcile text: ${status}`);
    const search = await tool('databrain_search', { query: 'queuedmarkera' });
    assert(/Indexing is running; the folder change will apply when it finishes/.test(search) && !RESTART_WORDS.test(search), `search must say the change is queued: ${search.slice(0, 400)}`);
    assert(!(await indexText()).includes('note-b.md'), 'the change must not apply while work is running');
    await until(async () => { const text = await tool('databrain_setup_status'); assert(!RESTART_WORDS.test(text), `no restart or reconcile text: ${text}`); return /Stage: (?:verification pending|ready)\./.test(text) && (await indexText()).includes('note-b.md') && !(await indexText()).includes('note-c.md') && text.includes('Selected source folders: 2'); }, 'the queued change applied when the work ended');
    for (const leftover of ['queuedmarkerc', 'note-c.md', 'FolderCUnique']) assert.equal(grepAll(leftover, dataHome), '', `"${leftover}" from the removed folder must be gone everywhere`);
  });
  // 3) a first indexing run (not a refresh) dies mid-way and the folders have changed since (A and B -> A and C): the change is applied BEFORE
  //    the dead job resumes, so the resumed run works from the current list instead of re-indexing the removed folder and pruning it at the end.
  //    (A dead refresh gets its earlier stage back at startup, so only a dead first run stays at "indexing".) Observed while the resumed job is still running.
  await fs.rm(dataHome, { recursive: true, force: true });
  await session([folders.A, folders.B], { DATABRAIN_TEST_INDEX_DELAY_MS: '120000' }, async (tool, child) => {
    await tool('databrain_setup_start');
    await until(async () => /Running now: initial indexing/.test(await tool('databrain_setup_status')), 'first indexing running');
    child.kill('SIGKILL');
  });
  const savedState = async () => JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'));
  assert.deepEqual((await savedState()).roots.sort(), [folders.A, folders.B].sort(), 'the dead job was started with folders A and B');
  await session([folders.A, folders.C], { DATABRAIN_TEST_INDEX_DELAY_MS: '120000' }, async tool => {
    await until(async () => /Running now: initial indexing/.test(await tool('databrain_setup_status')), 'the dead first run resumed');
    const state = await savedState();
    assert.deepEqual([...state.roots].sort(), [folders.A, folders.C].sort(), `the resumed job must use the current folder list, not the dead job's: ${state.roots}`);
  });
  console.log('PASS: a folder change during running or interrupted indexing is queued, said plainly, applied by itself at the end, with removed folders fully pruned and no restart or reconcile text; status names the running job and its ID; a dead job resumes with the current folder list.');
} finally {
  for (const child of orphans) child.kill('SIGKILL');
  await sleep(2000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
