// Part 29b: an app that has NEVER been indexed may be started ONCE to index it (Mel: "it should just open when it needs to get indexed").
// An app that was indexed before is never started (Part 29, see test_apps_never_started.mjs).
//  Gate 1: never-indexed app, closed: started exactly once, its content indexed, quit afterwards; the log says app-started-for-first-index / app-quit-after-first-index.
//  Gate 2: never-indexed app, already open: read, NOT started and NOT quit.
//  Gate 3: indexed-before app, closed, then a refresh that reads the apps again (a file changes) and a new server (a new chat): never started again.
//  Gate 4: the first read fails (the app answers with an error) or the user said Don't Allow: no second start on later calls and later servers.
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
const NAME = 'Datebook';
const servers = []; const temps = [];
let n = 0;

// one world: its own fake HOME, Applications folder with one stand-in app, interpreter and lifecycle stand-ins
async function world(tag) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `databrain-firstidx-${tag}-`))); temps.push(temp);
  const home = path.join(temp, 'home'); await fs.mkdir(home, { recursive: true });
  const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
  const realApps = await fs.realpath(appsDir);
  const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
  const realDocs = await fs.realpath(docs);
  await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nfirstidxplain an ordinary note.\n');
  const bundle = path.join(appsDir, `${NAME}.app`, 'Contents');
  await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.${NAME.toLowerCase()}</string><key>CFBundleName</key><string>${NAME}</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>`);
  await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);
  const rowsFile = path.join(temp, 'rows.json'); const modeFile = path.join(temp, 'mode.txt'); await fs.writeFile(modeFile, 'ok');
  await fs.writeFile(rowsFile, JSON.stringify([{ i: 'd-1', t: 'First page', b: `zorb${tag}marker written in the app`, d: '2026-01-01T10:00:00Z', c: 'Home' }]));
  const stub = path.join(temp, 'interpreter-stub.mjs');
  await fs.writeFile(stub, `#!${process.execPath}
import fs from 'node:fs';
const script = process.argv[5];
const mode = fs.readFileSync(process.env.MODE_FILE, 'utf8').trim();
const rows = JSON.parse(fs.readFileSync(process.env.ROWS_FILE, 'utf8'));
if (mode === 'fail') { console.error('the app did not answer'); process.exit(4); }
if (mode === 'deny') { console.error('Not authorized to send Apple events (-1743)'); process.exit(1); }
if (script.includes('// dates only')) console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) }));
else if (script.includes('// fetch by id')) { const ids = JSON.parse(script.match(/for \\(const id of (\\[.*?\\])\\)/)[1]); console.log(JSON.stringify(rows.filter(r => ids.includes(r.i)))); }
else if (script.includes('// full read')) console.log(JSON.stringify(rows));
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });
  const calls = path.join(temp, 'lifecycle-calls.log'); const openFile = path.join(temp, 'app-is-open');
  const lifecycle = path.join(temp, 'lifecycle-stub.mjs');
  await fs.writeFile(lifecycle, `#!${process.execPath}
import fs from 'node:fs';
const [action] = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, action + '\\n');
if (action === 'launch') fs.writeFileSync(process.env.OPEN_FILE, 'on');
if (action === 'quit') fs.rmSync(process.env.OPEN_FILE, { force: true });
if (action === 'running') console.log(fs.existsSync(process.env.OPEN_FILE) ? 'true' : 'false');
`, { mode: 0o755 });
  const dataHome = path.join(home, 'DataBrain');
  const w = {
    temp, realDocs, openApp: () => fs.writeFile(openFile, 'on'), closeApp: () => fs.rm(openFile, { force: true }), isOpen: () => fs.access(openFile).then(() => true, () => false),
    setMode: mode => fs.writeFile(modeFile, mode),
    calls: async () => (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean),
    timing: async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => line.split('\t')),
    start() {
      const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], { env: { ...process.env, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300', HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_RECENT_MS: '0', DATABRAIN_TEST_APP_OSASCRIPT: stub, DATABRAIN_TEST_APP_LIFECYCLE: lifecycle, ROWS_FILE: rowsFile, MODE_FILE: modeFile, CALLS: calls, OPEN_FILE: openFile, DATABRAIN_FRESHNESS_CHECK_MS: '100' }, stdio: ['pipe', 'pipe', 'pipe'] });
      servers.push(child);
      const waiting = new Map();
      readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
      const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
      const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
      const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
      return { child, tool, ready };
    },
  };
  w.settle = async () => { await until(async () => { const rows = await w.timing(); const open = new Set(); for (const f of rows) { if (f[3] === 'job-start') open.add(f[2]); else if (f[3] === 'job-end') open.delete(f[2]); } return open.size === 0; }, `jobs idle:\n${(await w.timing()).filter(f => ['job-start', 'job-end'].includes(f[3])).slice(-8).map(f => f.slice(1, 4).join(' ')).join('\n')}`, 120000); await sleep(500); };
  w.setup = async () => { const server = w.start(); await server.ready; await server.tool('databrain_setup_start'); await until(async () => /Stage: (?:verification pending|ready)\./.test(await server.tool('databrain_setup_status')), 'setup finishes', 120000); await w.settle(); return server; };
  w.newChat = async (server) => { server?.child.kill(); await sleep(500); const next = w.start(); await next.ready; await sleep(6000); await w.settle(); return next; };   // a new server: its start-up app check runs a few seconds after the start
  w.dropMirror = () => fs.rm(path.join(dataHome, 'app-content'), { recursive: true, force: true });
  w.report = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'app-report.json'), 'utf8').catch(() => '')).slice(0, 700);
  w.count = async action => (await w.calls()).filter(c => c === action).length;
  w.eventLines = async name => (await w.timing()).filter(f => f[3] === name && /^Datebook/.test(f[5] ?? ''));
  return w;
}

try {
  // Gate 1: never indexed, closed at setup
  {
    const w = await world('one');
    const server = await w.setup();
    assert.equal(await w.count('launch'), 1, `gate 1: started exactly once (calls: ${(await w.calls()).join(',')})`);
    assert.equal(await w.count('quit'), 1, `gate 1: quit afterwards (calls: ${(await w.calls()).join(',')})`);
    assert(!(await w.isOpen()), 'gate 1: the app is closed again when setup is done');
    assert(/zorbonemarker written in the app/.test(await server.tool('databrain_search', { query: 'zorbonemarker' })), 'gate 1: the app content was indexed');
    assert((await w.eventLines('app-started-for-first-index')).length === 1 && (await w.eventLines('app-quit-after-first-index')).length === 1, 'gate 1: the log has one started line and one quit line');
    const order = (await w.calls()).filter(c => ['launch', 'quit'].includes(c)).join(',');
    assert.equal(order, 'launch,quit', `gate 1: order of start and quit (${order})`);
    console.log('gate 1: never-indexed app, closed: started once, indexed, quit again, logged: PASS');

    // Gate 3: indexed before, closed: a refresh that reads the apps again and a new chat never start it
    await fs.writeFile(path.join(w.realDocs, 'second.md'), '# Second\nfirstidxsecond a later note.\n');
    await until(async () => /firstidxsecond/.test(await server.tool('databrain_search', { query: 'firstidxsecond' })), 'a changed file is indexed (a refresh read the apps again)', 90000);
    await w.settle();
    const chat = await w.newChat(server);
    assert(/zorbonemarker written in the app/.test(await chat.tool('databrain_search', { query: 'zorbonemarker' })), 'gate 3: the earlier app content is still searchable');
    await w.settle();
    // the app mirror is gone (so the start-up check does a full read of the app, not a dates check): the app is closed and was indexed before
    chat.child.kill(); await sleep(500); await w.dropMirror();
    const again = await w.newChat(null); await again.tool('databrain_search', { query: 'zorbonemarker' });
    await w.settle();
    assert.equal(await w.count('launch'), 1, `gate 3: an app indexed before is never started again, by a refresh, a new chat or a full read (calls: ${(await w.calls()).join(',')})`);
    console.log('gate 3: indexed-before app, closed: a refresh and a new chat never start it: PASS');
  }

  // Gate 2: never indexed, but already open
  {
    const w = await world('two');
    await w.openApp();
    const server = await w.setup();
    assert.equal(await w.count('launch'), 0, `gate 2: an open app is not started (calls: ${(await w.calls()).join(',')})`);
    assert.equal(await w.count('quit'), 0, `gate 2: an app the user had open is NOT quit (calls: ${(await w.calls()).join(',')})`);
    assert(await w.isOpen(), 'gate 2: the app is still open');
    assert(/zorbtwomarker written in the app/.test(await server.tool('databrain_search', { query: 'zorbtwomarker' })), 'gate 2: the app content was indexed');
    assert(!(await w.timing()).some(f => f[3] === 'app-started-for-first-index'), 'gate 2: no started line in the log');
    console.log('gate 2: never-indexed app, already open: read, not started, not quit: PASS');
  }

  // Gate 4: the first read fails / Don't Allow: no second start
  for (const mode of ['fail', 'deny']) {
    const w = await world(mode);
    await w.setMode(mode);
    let server = await w.setup();
    assert.equal(await w.count('launch'), 1, `gate 4 (${mode}): the first read starts the app once (calls: ${(await w.calls()).join(',')})`);
    assert.equal(await w.count('quit'), 1, `gate 4 (${mode}): and quits it again`);
    await server.tool('databrain_search', { query: 'plain' });
    await fs.writeFile(path.join(w.realDocs, 'next.md'), `# Next\nfirstidxnext${mode} a later note.\n`);
    await until(async () => new RegExp(`firstidxnext${mode}`).test(await server.tool('databrain_search', { query: `firstidxnext${mode}` })), 'a refresh ran', 90000);
    await w.settle();
    server = await w.newChat(server);
    await server.tool('databrain_search', { query: 'plain' });
    server = await w.newChat(server);
    await w.setMode('ok');   // even when the app would answer now, it is not started again (the part 29 rule)
    await server.tool('databrain_search', { query: 'plain' }); await sleep(1500);
    assert.equal(await w.count('launch'), 1, `gate 4 (${mode}): no second start on later calls, refreshes or new chats (calls: ${(await w.calls()).join(',')})\nreport: ${await w.report()}\nlog: ${(await w.timing()).filter(f => /app-|first/.test(f[3] || '')).map(f => f.slice(1, 6).join(' ')).join(' | ')}`);
    console.log(`gate 4 (${mode}): the first read failed: no second start: PASS`);
    // Gate 5 (Part 29c): the "tried" mark stops only the START, never a later READ. The user opens the app themselves (a slow Allow click, or Don't Allow turned on in
    // System Settings): the next check reads it, its content becomes searchable, and DataBrain still started nothing.
    await w.openApp();
    server = await w.newChat(server);
    await until(async () => new RegExp(`zorb${mode}marker written in the app`).test(await server.tool('databrain_search', { query: `zorb${mode}marker` })), `gate 5 (${mode}): the app content is searchable once the user has opened the app\nreport: ${await w.report()}`, 90000);
    assert.equal(await w.count('launch'), 1, `gate 5 (${mode}): still no second start (calls: ${(await w.calls()).join(',')})`);
    assert.equal(await w.count('quit'), 1, `gate 5 (${mode}): an app the user opened is not quit (calls: ${(await w.calls()).join(',')})`);
    console.log(`gate 5 (${mode}): the user opened the app later: it is read and searchable, nothing started or quit by DataBrain: PASS`);
  }
  console.log('apps first index: PASS');
} finally {
  for (const child of servers) child.kill('SIGKILL');
  await sleep(1200);
  for (const temp of temps) await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
