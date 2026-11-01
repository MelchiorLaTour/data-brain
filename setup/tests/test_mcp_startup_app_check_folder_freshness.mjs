// A new ordinary file added during an unchanged startup app check must converge through health rechecks alone.
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
const tempRoot = process.env.DATABRAIN_TEST_SCRATCH_ROOT || os.tmpdir();
const temp = await fs.realpath(await fs.mkdtemp(path.join(tempRoot, 'databrain-startup-health-')));
const home = path.join(temp, 'home');
await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000, interval = 200) {
  const started = Date.now();
  while (!(await check())) {
    assert(Date.now() - started < limit, `timed out: ${label}`);
    await sleep(interval);
  }
}

const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
const ordinaryFile = path.join(realDocs, 'ordinary-added-during-app-check.md');
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nstartupHealthBaseline ordinary note.\n');
const bundle = path.join(appsDir, 'Datebook.app', 'Contents');
await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
await fs.writeFile(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.datebook</string><key>CFBundleName</key><string>Datebook</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>');
await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>');

const fixture = path.join(temp, 'fixture.json');
const delayFile = path.join(temp, 'dates-delay-ms.txt');
const calls = path.join(temp, 'calls.log');
const rows = [{ i: 'one', t: 'First page', b: 'startupHealthAppBaseline.', d: '2026-01-01T10:00:00Z', c: 'Home' }];
await fs.writeFile(fixture, JSON.stringify(rows));
await fs.writeFile(delayFile, '0');
const stub = path.join(temp, 'interpreter-stub.mjs');
await fs.writeFile(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const script = process.argv[5];
const rows = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
const log = name => fs.appendFileSync(process.env.CALL_LOG, name + '\\n');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
if (script.includes('// dates only')) {
  log('dates');
  await wait(Number(fs.readFileSync(process.env.DELAY_FILE, 'utf8')) || 0);
  console.log(JSON.stringify({ ids: rows.map(row => row.i), d: rows.map(row => row.d) }));
} else if (script.includes('// fetch by id')) {
  log('fetch');
  const ids = JSON.parse(script.match(/for \\(const id of (\\[.*?\\])\\)/)[1]);
  console.log(JSON.stringify(rows.filter(row => ids.includes(row.i))));
} else if (script.includes('// full read')) {
  log('full');
  await wait(Number(fs.readFileSync(process.env.DELAY_FILE, 'utf8')) || 0);
  console.log(JSON.stringify(rows));
} else {
  console.error('unexpected interpreter script');
  process.exit(4);
}
`, { mode: 0o755 });
const stubSyntax = spawnSync(process.execPath, ['--check', stub], { encoding: 'utf8' });
assert.equal(stubSyntax.status, 0, `generated interpreter stub parses: ${stubSyntax.stderr}`);

const dataHome = path.join(home, 'DataBrain');
const statePath = path.join(dataHome, '.databrain', 'desktop-state.json');
const reportPath = path.join(dataHome, '.databrain', 'app-report.json');
const timingPath = path.join(dataHome, '.databrain', 'stage-timing.log');
const baseEnv = {
  ...process.env,
  HOME: home,
  DATABRAIN_TEST_APP_DIRS: appsDir,
  DATABRAIN_TEST_APP_OSASCRIPT: stub,
  DATABRAIN_TEST_APP_RECENT_MS: '0',
  DATABRAIN_FRESHNESS_CHECK_MS: '100',
  DATABRAIN_TEST_LOCK_POLL_MS: '100',
  FIXTURE: fixture,
  DELAY_FILE: delayFile,
  CALL_LOG: calls,
};
let requestId = 0;
function startServer() {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], { env: baseEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const failWaiting = error => { for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(error); } waiting.clear(); };
  child.once('error', error => failWaiting(new Error(`server failed to start: ${error.message}`)));
  child.once('exit', (code, signal) => failWaiting(new Error(`server exited (code=${code}, signal=${signal || 'none'}): ${stderr}`)));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch (error) { failWaiting(new Error(`invalid server JSON: ${error.message}; stderr=${stderr}`)); return; }
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id); clearTimeout(pending.timer); pending.resolve(message);
  });
  const ask = (method, params) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`DataBrain RPC timed out: ${method}; stderr=${stderr}`)); }, 30000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
      if (!error) return;
      const pending = waiting.get(id);
      if (pending) { waiting.delete(id); clearTimeout(timer); reject(new Error(`DataBrain RPC write failed: ${error.message}`)); }
    });
  });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = (async () => {
    await ask('initialize', { protocolVersion: '2025-03-26' });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  })();
  return { child, tool, ready };
}
const timing = async () => (await fs.readFile(timingPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => line.split('\t'));
const appCheckCount = async event => (await timing()).filter(row => row[1] === 'app check' && row[3] === event).length;
const refreshCount = async event => (await timing()).filter(row => row[1] === 'refresh' && row[3] === event).length;
const housekeepingCount = async event => (await timing()).filter(row => row[1] === 'index housekeeping' && row[3] === event).length;
const callLog = async () => (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const savedStage = async () => JSON.parse(await fs.readFile(statePath, 'utf8')).stage;
const servers = [];

try {
  const setup = startServer(); servers.push(setup); await setup.ready;
  await setup.tool('databrain_setup_start');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'initial setup reaches ready');
  await until(async () => {
    const log = await timing();
    return ['initial indexing', 'refresh', 'app check'].every(kind =>
      log.filter(row => row[1] === kind && row[3] === 'job-start').length === log.filter(row => row[1] === kind && row[3] === 'job-end').length);
  }, 'initial setup and app reads finish');
  const appReport = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert((appReport.summaries || []).some(summary => summary.name === 'Datebook' && summary.status === 'included'), `the synthetic app was included: ${JSON.stringify(appReport.summaries)}`);
  assert.match(await setup.tool('databrain_search', { query: 'startupHealthAppBaseline' }), /From your files: Datebook/, 'the synthetic app baseline is searchable before the new ordinary file is created');
  setup.child.kill('SIGKILL'); await sleep(500);

  const hourAgo = new Date(Date.now() - 3600000);
  await fs.utimes(reportPath, hourAgo, hourAgo);
  await fs.writeFile(calls, '');
  await fs.writeFile(delayFile, '7000');
  const startsBefore = await appCheckCount('job-start');
  const endsBefore = await appCheckCount('job-end');
  const refreshStartsBefore = await refreshCount('job-start');
  const refreshEndsBefore = await refreshCount('job-end');
  const housekeepingEndsBefore = await housekeepingCount('job-end');
  const checking = startServer(); servers.push(checking); await checking.ready;
  await until(async () => (await appCheckCount('job-start')) > startsBefore && (await callLog()).includes('full'), 'the second server begins its slow app read', 30000).catch(async error => {
    throw new Error(`${error.message}\nstage: ${await savedStage().catch(() => 'unavailable')}\napp report: ${await fs.readFile(reportPath, 'utf8').catch(() => 'unavailable')}\napp calls: ${JSON.stringify(await callLog())}\nstage timing:\n${(await timing()).slice(-30).map(row => row.join('\t')).join('\n')}`);
  });
  await fs.writeFile(ordinaryFile, '# Ordinary file added during app check\nstartupHealthNewFolderMarker.\n');

  const firstHealth = await checking.tool('databrain_health');
  assert.match(firstHealth, /Source freshness: stale: 1 added/, `health sees the new ordinary file while the app check runs:\n${firstHealth}`);
  assert.match(firstHealth, /App check: running/, `health identifies the slow unchanged app check:\n${firstHealth}`);
  const runningDiagnostics = await checking.tool('databrain_diagnostics');
  assert.match(runningDiagnostics, /^Running jobs: app check: running \(job ID [0-9a-f-]+; started \d{4}-\d{2}-\d{2}T[^\n]+Z\)$/m, `diagnostics identify the active job and its start time:\n${runningDiagnostics}`);
  assert.deepEqual(await callLog(), ['full'], 'the startup app check read the unchanged synthetic app once');

  const startedWaitingAt = Date.now();
  const healthHistory = [firstHealth];
  let current = /Source freshness: current\./.test(firstHealth);
  while (!current && Date.now() - startedWaitingAt < 30000) {
    await sleep(300);
    const report = await checking.tool('databrain_health');
    healthHistory.push(report);
    if (healthHistory.length > 5) healthHistory.shift();
    current = /Source freshness: current\./.test(report);
  }
  assert(current, `health-only rechecks converge to current after the app check finishes; latest reports:\n${healthHistory.join('\n---\n')}\nstage timing:\n${(await timing()).slice(-20).map(row => row.join('\t')).join('\n')}`);
  await until(async () => (await appCheckCount('job-end')) > endsBefore, 'the unchanged app check ends');
  await until(async () => (await refreshCount('job-end')) > refreshEndsBefore, 'the ordinary file refresh completes');
  await until(async () => (await housekeepingCount('job-end')) > housekeepingEndsBefore, 'index housekeeping after the ordinary file refresh completes');
  assert((await refreshCount('job-start')) > refreshStartsBefore, 'the file is refreshed without a search or setup-status call');
  assert.deepEqual(await callLog(), ['full'], 'refreshing the ordinary file did not trigger another app read');
  assert((await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8')).includes(ordinaryFile), 'the ordinary file is in the index');
  assert.match(await checking.tool('databrain_diagnostics'), /^Running jobs: none$/m, 'completed jobs are absent from the running-jobs line');
  await fs.writeFile(delayFile, '0');
  const completionStatus = await checking.tool('databrain_setup_status');
  assert.match(completionStatus, /app check: complete — Apps read at start; apps unchanged; a folder freshness check queued a background refresh\./, `status identifies the unchanged app and folder freshness refresh:\n${completionStatus}`);
  console.log('PASS: an unchanged startup app check does not strand a new ordinary file; health-only rechecks converge without search, then completion status identifies the queued folder refresh.');
} finally {
  for (const server of servers) server.child.kill('SIGKILL');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
