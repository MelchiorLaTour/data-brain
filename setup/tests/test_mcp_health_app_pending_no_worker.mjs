// App-mirror content without an active index worker is stale, not "being updated now".
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
const tempRoot = process.env.DATABRAIN_TEST_SCRATCH_ROOT || os.tmpdir();
const temp = await fs.realpath(await fs.mkdtemp(path.join(tempRoot, 'databrain-app-pending-')));
const home = path.join(temp, 'home'); await fs.mkdir(home, { recursive: true });
const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nappPendingBaseNote.\n');

const appContents = path.join(appsDir, 'Datebook.app', 'Contents');
await fs.mkdir(path.join(appContents, 'Resources'), { recursive: true });
await fs.writeFile(path.join(appContents, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.datebook</string><key>CFBundleName</key><string>Datebook</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>');
await fs.writeFile(path.join(appContents, 'Resources', 'D.sdef'), '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>');

const fixture = path.join(temp, 'fixture.json');
await fs.writeFile(fixture, JSON.stringify([{ i: 'one', t: 'First page', b: 'appPendingAppBaseline', d: '2026-01-01T10:00:00Z', c: 'Home' }]));
const stub = path.join(temp, 'interpreter-stub.mjs');
await fs.writeFile(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const script = process.argv[5];
const rows = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
if (script.includes('// dates only')) console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) }));
else if (script.includes('// fetch by id')) { const ids = JSON.parse(script.match(/for \\(const id of (\\[.*?\\])\\)/)[1]); console.log(JSON.stringify(rows.filter(r => ids.includes(r.i)))); }
else if (script.includes('// full read')) console.log(JSON.stringify(rows));
else process.exit(4);
`, { mode: 0o755 });

const dataHome = path.join(home, 'DataBrain');
let id = 0;
function startServer() {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], {
    env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, DATABRAIN_TEST_APP_RECENT_MS: '0', FIXTURE: fixture, DATABRAIN_FRESHNESS_CHECK_MS: '100' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  const failPending = error => {
    for (const entry of waiting.values()) { clearTimeout(entry.timer); entry.reject(error); }
    waiting.clear();
  };
  child.once('error', error => failPending(new Error(`DataBrain server failed to start: ${error.message}`)));
  child.once('exit', (code, signal) => failPending(new Error(`DataBrain server exited before replying (code=${code}, signal=${signal || 'none'}).`)));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch (error) { failPending(new Error(`DataBrain server returned invalid JSON: ${error.message}`)); return; }
    const entry = waiting.get(msg.id);
    if (!entry) return;
    waiting.delete(msg.id); clearTimeout(entry.timer); entry.resolve(msg);
  });
  const ask = (method, params) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode) { reject(new Error('DataBrain server is not running.')); return; }
    const requestId = ++id;
    const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error(`DataBrain RPC timed out: ${method}`)); }, 30000);
    timer.unref?.();
    waiting.set(requestId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`, error => {
      if (!error) return;
      const entry = waiting.get(requestId);
      if (!entry) return;
      waiting.delete(requestId); clearTimeout(entry.timer); reject(new Error(`DataBrain RPC write failed: ${error.message}`));
    });
  });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, tool, ready };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) {
  const started = Date.now();
  while (!(await check())) { assert(Date.now() - started < limit, `timed out: ${label}`); await sleep(250); }
}
const timing = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => line.split('\t'));
const activeIndexJobs = rows => {
  const events = rows.filter(row => ['app check', 'refresh', 'index housekeeping', 'initial indexing'].includes(row[1]) && ['job-start', 'job-end'].includes(row[3]));
  return events.reduce((count, row) => count + (row[3] === 'job-start' ? 1 : -1), 0);
};
let server;
try {
  server = startServer(); await server.ready;
  await server.tool('databrain_setup_start');
  await until(async () => /Stage: ready\./.test(await server.tool('databrain_setup_status')), 'setup reaches ready');
  await until(async () => activeIndexJobs(await timing()) === 0, 'startup app and index jobs finish');
  const appReport = JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'app-report.json'), 'utf8'));
  assert((appReport.summaries || []).some(summary => summary.name === 'Datebook' && summary.status === 'included'), `fake app baseline was included: ${JSON.stringify(appReport.summaries)}`);
  assert.match(await server.tool('databrain_search', { query: 'appPendingAppBaseline' }), /From your files: Datebook/, 'the fake app baseline is searchable before injecting pending content');
  const appMirror = path.join(dataHome, 'app-content');
  const pendingPage = path.join(appMirror, 'Datebook', 'Home', 'Pending synthetic page.md');
  await fs.mkdir(path.dirname(pendingPage), { recursive: true });
  await fs.writeFile(pendingPage, '# Pending synthetic page\nappPendingUniqueMarker.\n');
  assert.equal(activeIndexJobs(await timing()), 0, 'no app check or index worker is running before health');

  const healthWithoutWorker = await server.tool('databrain_health');
  const evidenceDir = process.env.DATABRAIN_TEST_SCRATCH_ROOT || temp;
  await fs.writeFile(path.join(evidenceDir, 'app-pending-no-worker-evidence.txt'), [
    `app report statuses: ${(appReport.summaries || []).map(summary => `${summary.name}:${summary.status}`).join(', ') || 'none'}`,
    `active index/app jobs before health: ${activeIndexJobs(await timing())}`,
    `health output:\n${healthWithoutWorker}`,
    `stage timing:\n${(await timing()).map(row => row.join('\t')).join('\n')}`,
  ].join('\n\n') + '\n');
  assert.match(healthWithoutWorker, /Source freshness: stale: 1 added/, `the missing mirror item is stale:\n${healthWithoutWorker}`);
  assert.match(healthWithoutWorker, /The check reported an issue/, `health must not imply a worker is applying the item:\n${healthWithoutWorker}`);

  const search = await server.tool('databrain_search', { query: 'appPendingUniqueMarker' });
  await until(async () => /Pending synthetic page/.test(await server.tool('databrain_search', { query: 'appPendingUniqueMarker' })), 'ordinary source use refreshes the pending mirror item');
  const current = await server.tool('databrain_health');
  assert.match(current, /Source freshness: current\./, `health converges after the ordinary refresh:\n${current}`);
  assert.match(search, /Refreshing in the background|Pending synthetic page/, `the first search either starts or sees the refresh:\n${search}`);
  console.log('PASS: pending app-mirror content with no active worker is reported stale; normal source use refreshes it and health becomes current.');
} finally {
  server?.child.kill('SIGKILL');
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
