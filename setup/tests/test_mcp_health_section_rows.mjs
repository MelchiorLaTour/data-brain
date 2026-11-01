// A long source can have many FTS section rows but still represents one indexed file.
// Health compares source-file coverage, not the number of sections in the FTS table.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const here = path.dirname(new URL(import.meta.url).pathname);
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-healthsections-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents');
const dataHome = path.join(home, 'DataBrain'); const engine = path.join(temp, 'engine');
const database = path.join(dataHome, 'moc', 'fts.db');
await fs.mkdir(docs, { recursive: true });
await fs.cp(path.join(here, '../../bin'), path.join(engine, 'bin'), { recursive: true });
await fs.mkdir(path.join(engine, 'setup', 'mcp'), { recursive: true });
await fs.writeFile(path.join(engine, 'setup', 'mcp', 'pdf-extract.js'), `ObjC.import('Foundation');
function run(argv) {
  const head = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0], 4, $())).slice(0, 8);
  return head === 'LONGTEXT' ? 'ordinary synthetic words '.repeat(42000) + ' sectionhealthmarker' : 'small synthetic note';
}
`);
await fs.writeFile(path.join(docs, 'long-atlas.pdf'), 'LONGTEXT\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, limit = 180000) => {
  for (const started = Date.now(); ; ) {
    const value = await check();
    if (value) return value;
    assert(Date.now() - started < limit, `timed out: ${label}`);
    await sleep(300);
  }
};
let id = 0; const waiting = new Map();
const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], {
  env: { ...process.env, HOME: home, DATABRAIN_ENGINE_DIR: engine, DATABRAIN_FRESHNESS_CHECK_MS: '3600000' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
readline.createInterface({ input: child.stdout }).on('line', line => {
  const message = JSON.parse(line);
  waiting.get(message.id)?.(message);
});
const request = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id;
  const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error(`Timed out: ${method}`)); }, 120000);
  waiting.set(requestId, message => { clearTimeout(timer); resolve(message); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
});
const tool = async (name, args = {}) => {
  const reply = await request('tools/call', { name, arguments: args });
  return reply.result?.content?.[0]?.text ?? '';
};
try {
  await request('initialize', { protocolVersion: '2025-03-26' });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  const status = await until(async () => {
    const current = await tool('databrain_setup_status');
    return /Stage: ready\./.test(current) ? current : /Stage: stopped\./.test(current) ? assert.fail(current) : null;
  }, 'fresh setup reaches ready');
  assert.match(status, /DataBrain is ready/);
  const count = spawnSync('/usr/bin/sqlite3', ['-readonly', database, 'SELECT count(*), count(DISTINCT path) FROM notes;'], { encoding: 'utf8' });
  assert.equal(count.status, 0, count.stderr);
  const [sectionRows, sourcePaths] = count.stdout.trim().split('|').map(Number);
  assert(sectionRows > sourcePaths && sourcePaths === 1, `synthetic long PDF must produce multiple section rows: ${count.stdout}`);

  const healthy = await tool('databrain_health');
  assert.match(healthy, new RegExp(`Ranked search database: 1 source file; ${sectionRows} FTS section rows; quick_check ok\\.`), healthy);
  assert.doesNotMatch(healthy, /The check reported an issue/, healthy);
  const audit = await tool('databrain_verify_install');
  assert.match(audit, /PASS: Selected-source health/, audit);

  // Removing the one indexed path from this disposable FTS database must remain visible to health.
  const removed = spawnSync('/usr/bin/sqlite3', [database, 'DELETE FROM notes WHERE path = (SELECT path FROM notes LIMIT 1);'], { encoding: 'utf8' });
  assert.equal(removed.status, 0, removed.stderr);
  const missing = await tool('databrain_health');
  assert.match(missing, /The check reported an issue/, missing);
  const missingAudit = await tool('databrain_verify_install');
  assert.match(missingAudit, /FAIL: Selected-source health/, missingAudit);

  // An unreadable/corrupt disposable DB must still fail the SQLite quick check.
  const saved = `${database}.health-sections-fixture`;
  await fs.rename(database, saved);
  await fs.writeFile(database, 'synthetic corrupt SQLite database');
  try {
    const corrupt = await tool('databrain_health');
    assert.match(corrupt, /Ranked search database: check failed\./, corrupt);
    assert.match(corrupt, /The check reported an issue/, corrupt);
  } finally {
    await fs.rm(database, { force: true });
    await fs.rename(saved, database);
  }
  console.log(`PASS: ${sectionRows} FTS section rows for ${sourcePaths} source file(s) remain healthy; missing source-path coverage and a corrupt disposable database still fail health.`);
} finally {
  child.kill('SIGKILL');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
}
