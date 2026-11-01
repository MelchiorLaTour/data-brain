// Status, diagnostics and cancel only read saved state, so they must work while another process holds the indexing/write lock
// (build-fts.sh or a job in the middle of a write). A pending folder change used to make them try the lock and fail with
// "another DataBrain client is indexing", which led Claude to tell the user to quit Claude Desktop and kill a healthy job.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-lock-')));
const home = path.join(temp, 'home');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 180000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const folders = {};
for (const name of ['A', 'B']) {
  folders[name] = path.join(home, `Folder${name}Unique`);
  await fs.mkdir(folders[name], { recursive: true });
  folders[name] = await fs.realpath(folders[name]);
  await fs.writeFile(path.join(folders[name], `note-${name.toLowerCase()}.md`), `# ${name}\nlockmarker${name.toLowerCase()} text in folder ${name}.\n`);
}
const dataHome = path.join(home, 'DataBrain');
const LOCK_ERROR = /another databrain (?:client|job)|quit claude|indexing or changing this brain/i;

async function session(roots, env, run) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => { const r = (await ask('tools/call', { name, arguments: args })).result; return r?.content?.[0]?.text ?? ''; };
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool, child); }
  finally { child.kill('SIGKILL'); }
}

let holder = null;
async function holdLock() {   // what build-fts.sh or a write in another process looks like to the server: an exclusive SQLite transaction on the lock file
  const lockPath = path.join(dataHome, '.databrain', 'index-worker-lock.sqlite');
  holder = spawn('/usr/bin/sqlite3', ['-batch', lockPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  holder.stdout.on('data', part => { out += part; });
  holder.stdin.write("BEGIN EXCLUSIVE;\nSELECT 'HELD';\n");
  await until(async () => out.includes('HELD'), 'the test holds the lock');
}

try {
  // a finished brain with folders A and B
  await session([folders.A, folders.B], {}, async tool => {
    await tool('databrain_setup_start');
    await until(async () => /Stage: (?:verification pending|ready)\./.test((await tool('databrain_setup_status'))), 'setup finished');
  });

  await holdLock();

  // the settings now list only A: a pending folder change makes the server want the write lock on every call
  await session([folders.A], {}, async tool => {
    for (const name of ['databrain_setup_status', 'databrain_diagnostics']) {
      const text = await tool(name);
      assert(!LOCK_ERROR.test(text), `${name} must not fail or mention a lock while the lock is held: ${text.slice(0, 500)}`);
      assert(/Stage|DataBrain/i.test(text) && text.length > 200, `${name} must still report state while the lock is held: ${text.slice(0, 300)}`);
    }
    const cancel = await tool('databrain_cancel_job', { job_id: '00000000-0000-4000-8000-000000000000' });
    assert(!LOCK_ERROR.test(cancel), `cancel must not need the lock: ${cancel.slice(0, 500)}`);
    assert(/no longer active|cannot be cancelled|cancel/i.test(cancel), `cancel answers about the job itself: ${cancel.slice(0, 300)}`);
  });

  // when the lock is free again the pending change applies by itself
  holder.stdin.end('ROLLBACK;\n.quit\n');
  await sleep(500);
  await session([folders.A], {}, async tool => {
    await until(async () => { const text = await tool('databrain_setup_status'); return text.includes('Selected source folders: 1'); }, 'the folder change applied once the lock was free');
  });
  console.log('PASS: status, diagnostics and cancel work while the write lock is held by another process; the pending folder change applies later; the lock text no longer tells anyone to quit Claude Desktop.');
} finally {
  holder?.kill('SIGKILL');
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
