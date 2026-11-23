// Part 29: DataBrain never starts Notes, Reminders or any other app. Mel's retest (2026-11-21): the first search after a restart took 13.5 s because the
// app check started Notes (it showed on the screen), and a background check started it again after he had closed it.
//  Gate 1: the app is closed + a search: the app is never started or hidden (the lifecycle stand-in logs every call), the search answers fast,
//          the log says `app-check-skipped <App>: not running`, and the answer carries no warning.
//  Gate 2: the app is open + a search: the dates check runs as before and the edit is found. (A skipped check is not lost: it runs at the next check that finds the app open.)
//  Gate 3: idle, app closed (a new server starts, as for a new chat): the start-up check skips it too. DataBrain does not start an app even at idle (see the report: "hidden and quit
//          again" cannot be shown without opening the real apps).
//  Gate 4: what was read before stays searchable while the app is closed.
//  Gate B: with the app open and a very slow question (20 s) the search still answers inside its own short limit.
// Fake HOME, stand-in apps only. No real app is touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS; delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-neverstart-')));
const home = path.join(temp, 'home'); await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nneverstartplain an ordinary note.\n');
const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
const NAME = 'Datebook';
{
  const bundle = path.join(appsDir, `${NAME}.app`, 'Contents');
  await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.${NAME.toLowerCase()}</string><key>CFBundleName</key><string>${NAME}</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>`);
  await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);
}
const rowsFile = path.join(temp, `rows-${NAME}.json`);
const delayFile = path.join(temp, 'dates-delay-ms.txt'); await fs.writeFile(delayFile, '0');
const rowFor = (i, t, b, d) => ({ i, t, b, d, c: 'Home' });
const writeRows = rows => fs.writeFile(rowsFile, JSON.stringify(rows));
await writeRows([rowFor('d-1', 'First page', 'neverstartfirst written before', '2026-01-01T10:00:00Z'), rowFor('d-2', 'Second page', 'neverstartsecond written before', '2026-01-02T10:00:00Z')]);
const stub = path.join(temp, 'interpreter-stub.mjs');
await fs.writeFile(stub, `#!${process.execPath}
import fs from 'node:fs';
const script = process.argv[5];
const rows = JSON.parse(fs.readFileSync(process.env.ROWS_FILE, 'utf8'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
if (script.includes('// dates only')) { await wait(Number(fs.readFileSync(process.env.DELAY_FILE, 'utf8')) || 0); console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) })); }
else if (script.includes('// fetch by id')) { const ids = JSON.parse(script.match(/for \\(const id of (\\[.*?\\])\\)/)[1]); console.log(JSON.stringify(rows.filter(r => ids.includes(r.i)))); }
else if (script.includes('// full read')) console.log(JSON.stringify(rows));
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });
// the lifecycle stand-in: "running" answers from a state file; every call is logged; "launch" would open the app (it must never be called)
const calls = path.join(temp, 'lifecycle-calls.log'); const openFile = path.join(temp, 'app-is-open');
const lifecycle = path.join(temp, 'lifecycle-stub.mjs');
await fs.writeFile(lifecycle, `#!${process.execPath}
import fs from 'node:fs';
const [action] = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, action + '\\n');
if (action === 'launch') fs.writeFileSync(process.env.OPEN_FILE, 'on');
if (action === 'running') console.log(fs.existsSync(process.env.OPEN_FILE) ? 'true' : 'false');
`, { mode: 0o755 });
const openApp = () => fs.writeFile(openFile, 'on'); const closeApp = () => fs.rm(openFile, { force: true });
const lifecycleCalls = async () => (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const dataHome = path.join(home, 'DataBrain');
let n = 0; const servers = [];
function startServer() {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], { env: { ...process.env, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300', HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_RECENT_MS: '0', DATABRAIN_TEST_APP_OSASCRIPT: stub, DATABRAIN_TEST_APP_LIFECYCLE: lifecycle, ROWS_FILE: rowsFile, DELAY_FILE: delayFile, CALLS: calls, OPEN_FILE: openFile, DATABRAIN_FRESHNESS_CHECK_MS: '100' }, stdio: ['pipe', 'pipe', 'pipe'] });
  servers.push(child);
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, tool, ready };
}
const timing = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => line.split('\t'));
const settle = async () => { await until(async () => { const rows = await timing(); const open = new Set(); for (const f of rows) { if (f[3] === 'job-start') open.add(f[2]); else if (f[3] === 'job-end') open.delete(f[2]); } return open.size === 0; }, 'jobs idle', 120000); await sleep(500); };
const timed = async work => { const t0 = Date.now(); const value = await work(); return { value, ms: Date.now() - t0 }; };
const SEARCH_LIMIT_MS = 4000;   // a search with the app closed: one process-list question at most, no app start, no app question
try {
  // setup with the app OPEN: its first read is the content that must stay searchable later
  await openApp();
  let server = startServer(); await server.ready; await server.tool('databrain_setup_start');
  await until(async () => /Stage: (?:verification pending|ready)\./.test(await server.tool('databrain_setup_status')), 'setup finishes', 120000);
  await settle();
  assert(/neverstartfirst written before/.test(await server.tool('databrain_search', { query: 'neverstartfirst' })), 'the app content is indexed after setup (app open)');
  assert(!(await lifecycleCalls()).includes('launch'), 'setup with the app open never starts it');

  // Gate 1 + 4: the app is CLOSED, a later edit is waiting in it
  await closeApp();
  await writeRows([rowFor('d-1', 'First page', 'neverstartfirst written before', '2026-01-01T10:00:00Z'), rowFor('d-2', 'Second page', 'neverstartsecond written before', '2026-01-02T10:00:00Z'), rowFor('d-3', 'Third page', 'neverstartthird edit made while closed', '2026-03-03T10:00:00Z')]);
  await fs.rm(calls, { force: true }); await sleep(400);
  const mark = (await timing()).length;
  const closed = await timed(() => server.tool('databrain_search', { query: 'neverstartfirst' }));
  await sleep(1500);   // anything the check would still do in the background has started by now
  assert(/neverstartfirst written before/.test(closed.value), `gate 4: what was read before is still searchable while the app is closed:\n${closed.value.slice(0, 300)}`);
  assert(closed.ms < SEARCH_LIMIT_MS, `gate 1: a search with the app closed answers inside ${SEARCH_LIMIT_MS} ms (${closed.ms} ms)`);
  assert(!/New changes are being added|closed|not running/i.test(closed.value.split('\n').slice(0, 3).join('\n')), `gate 1: no warning in the answer:\n${closed.value.slice(0, 300)}`);
  let made = await lifecycleCalls();
  assert(!made.includes('launch') && !made.includes('hide'), `gate 1: the app is never started or hidden (calls: ${made.join(',')})`);
  const skipLines = (await timing()).slice(mark).filter(f => f[3] === 'app-check-skipped' && /^Datebook: not running/.test(f[5] ?? ''));
  assert(skipLines.length >= 1, `gate 1: the log says the check was skipped because the app is not running:\n${(await timing()).slice(mark).map(f => f.slice(3).join(' ')).join('\n')}`);
  assert(!(await timing()).slice(mark).some(f => f[3] === 'app-dates-check'), 'gate 1: no question was asked of the closed app');
  console.log(`gate 1 + 4: app closed: no start, skip logged, search ${closed.ms} ms, earlier content still found: PASS`);

  // Gate 2: the app is OPEN again: the check runs and finds the edit made while it was closed (a skipped check is not lost)
  await openApp(); await sleep(400);
  await until(async () => /neverstartthird edit made while closed/.test(await server.tool('databrain_search', { query: 'neverstartthird' })), 'the edit made while the app was closed is found once it is open', 60000);
  assert((await timing()).some(f => f[3] === 'app-dates-check' && /^Datebook: updated/.test(f[5] ?? '')), 'gate 2: the dates check ran with the app open');
  assert(!(await lifecycleCalls()).includes('launch'), 'gate 2: still never started');
  console.log('gate 2: app open: the dates check runs and the edit is found: PASS');
  await settle();

  // Gate 3: idle, app closed, a new server starts (a new chat): its start-up check skips the app too
  server.child.kill(); await sleep(500);
  await closeApp(); await fs.rm(calls, { force: true });
  const mark3 = (await timing()).length;
  server = startServer(); await server.ready;
  await sleep(6000);   // the start-up check runs by itself a few seconds after the start
  await settle();
  made = await lifecycleCalls();
  assert(!made.includes('launch') && !made.includes('hide'), `gate 3: the start-up check never starts the closed app (calls: ${made.join(',')})`);
  assert((await timing()).slice(mark3).some(f => f[3] === 'app-check-skipped' && /^Datebook: not running/.test(f[5] ?? '')), `gate 3: the start-up check logs the skip:\n${(await timing()).slice(mark3).map(f => f.slice(1, 4).concat(f.slice(5)).join(' ')).join('\n')}`);
  console.log('gate 3: idle, app closed: the start-up check skips it, nothing is started: PASS');

  // Gate B: the app is open and its question takes 20 s: the search still answers inside its own limit
  await openApp(); await fs.writeFile(delayFile, '20000');
  await writeRows([rowFor('d-1', 'First page', 'neverstartfirst written before', '2026-01-01T10:00:00Z'), rowFor('d-2', 'Second page', 'neverstartsecond written before', '2026-01-02T10:00:00Z'), rowFor('d-3', 'Third page', 'neverstartthird edit made while closed', '2026-03-03T10:00:00Z'), rowFor('d-4', 'Fourth page', 'neverstartfourth slow', '2026-04-04T10:00:00Z')]);
  await sleep(400);
  const slow = await timed(() => server.tool('databrain_search', { query: 'neverstartfirst' }));
  assert(/neverstartfirst written before/.test(slow.value) && slow.ms < SEARCH_LIMIT_MS, `gate B: a search answers inside ${SEARCH_LIMIT_MS} ms although the app takes 20 s to answer (${slow.ms} ms)`);
  console.log(`gate B: app open, question 20 s: search answered in ${slow.ms} ms: PASS`);
  console.log('apps never started: PASS');
} finally {
  for (const child of servers) child.kill('SIGKILL');
  await sleep(1200);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
