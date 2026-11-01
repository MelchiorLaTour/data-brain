// Gaps G2 + G3, REAL packages, one fake HOME. Old phase = the unzipped 0.1.37 package, new phase = the unzipped 0.1.38 package.
// Fake Applications folder = <fake HOME>/Applications (a path both Applications filters match). The osascript stub and the app are invented.
// G2: a Notes-style item "College email" (email + short token, no label) is indexed by 0.1.37 and UNCHANGED at 0.1.38's next export. It must
//     end up held and out of app-content/index/fts. Control: an item the user keeps through databrain_privacy decide stays indexed.
// G3: files lying in the fake Applications folder were indexed by 0.1.37 (the bug). Record the exact text of health call 1 on 0.1.38, whether
//     it starts a refresh, and health after the refresh (must report no gap).
// Mutant (GAP_MUTANT=skip-rescreen-and-screen): the 0.1.38 copy neither re-screens by rules version nor screens the app mirror -> must FAIL.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fakeHome, initialize, setupToReady, sleep, until } from './mcp-harness-0138.mjs';
import { sqlite, stagePackage } from './mcp-harness-gaps.mjs';

const { temp, home, docs, dataHome, statePath } = await fakeHome('gap-g2g3');
const oldServer = await stagePackage('0.1.37', path.join(temp, 'pkg-old'));
const newServer = await stagePackage('0.1.38', path.join(temp, 'pkg-new'));
if (process.env.GAP_MUTANT === 'skip-rescreen-and-screen') {
  let s = await fs.readFile(newServer, 'utf8'); const before = s;
  s = s.replace("if (rulesStale) files = await changedNoteFiles(null);", "");
  s = s.replace("  const screened = spawnSync('/usr/bin/perl', [path.join(engine, 'bin', 'privacy.pl'), 'filter'], { input: files.join('\\n'), encoding: 'utf8', env: engineEnv(), maxBuffer: 256 * 1024 * 1024 });\n  if (screened.status !== 0) throw new Error('The privacy screen failed on app content;", "  const screened = { status: 0, stdout: files.join('\\n') };\n  if (screened.status !== 0) throw new Error('The privacy screen failed on app content;");
  assert.notEqual(s, before, 'mutation applied'); await fs.writeFile(newServer, s);
}
const apps = path.join(home, 'Applications');
const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
const bundle = path.join(apps, 'Datebook.app', 'Contents');
await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
await fs.writeFile(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.datebook</string><key>CFBundleName</key><string>Datebook</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>');
await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);
const realApps = await fs.realpath(apps);
// files lying in the Applications folder (G3): 0.1.37 indexes them, 0.1.38 must not
await fs.mkdir(path.join(realApps, 'Pokemon Uranium 1.2.5'));
await fs.writeFile(path.join(realApps, 'Pokemon Uranium 1.2.5', 'readme.txt'), 'gapappsfilemarker text file lying in the Applications folder.\n');
await fs.writeFile(path.join(docs, 'plan.md'), '# Plan\ngapnotesmarker ordinary note.\n');
const fixture = path.join(temp, 'fixture.json'); const calls = path.join(temp, 'calls.log');
const itemsOld = [{ i: 'x-1', t: 'Garden plan', b: 'gapnotesmarker tomatoes need staking.', d: '2026-01-02T10:00:00Z', c: 'Home' },
  { i: 'x-2', t: 'College email', b: 'sample.person@example.edu\n\nnote to self\nc014d1', d: '2026-01-03T10:00:00Z', c: 'Home' }];
await fs.writeFile(fixture, JSON.stringify(itemsOld));
const stub = path.join(temp, 'interpreter-stub.mjs');
await fs.writeFile(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const script = process.argv[5];
const rows = JSON.parse(fs.readFileSync(process.env.FIXTURE_A, 'utf8'));
const log = line => fs.appendFileSync(process.env.CALL_LOG, line + '\\n');
const need = (...needles) => { for (const n of needles) if (!script.includes(n)) { console.error('missing ' + n); process.exit(2); } };
if (script.includes('// dates only')) { need('app.pages', 'c.id()', 'c.modificationDate()'); log('dates'); console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) })); }
else if (script.includes('// fetch by id')) { need('c.byId(id)', 'it.title()', 'it.text()', 'it.modificationDate()', 'it.locked()'); const ids = JSON.parse(script.match(/for \\\\(const id of (\\\\[.*?\\\\])\\\\)/)[1]); log('fetch ' + ids.join(',')); console.log(JSON.stringify(rows.filter(r => ids.includes(r.i)))); }
else if (script.includes('// full read')) { need('app.pages', 'c.title()', 'c.text()', 'c.id()'); log('full'); console.log(JSON.stringify(rows)); }
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });

const run = serverPath => {
  const child = spawn(process.execPath, [serverPath, '--databrain-source-roots', realApps, docs], { env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: realApps, DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE_A: fixture, CALL_LOG: calls, DATABRAIN_FRESHNESS_CHECK_MS: '100' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return { child, ask, tool: async (name, args = {}) => { const r = await ask('tools/call', { name, arguments: args }); return r.result?.content?.[0]?.text ?? r.error?.message ?? ''; } };
};
const index = () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
const state = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
const callLines = async () => (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const callCount = async () => (await callLines()).length;
const idle = async server => until(async () => { const t = await server.tool('databrain_setup_status'); return /Stage: ready\./.test(t) && !/Running now/.test(t); }, 'job finished', 240000);
let server;
try {
  // ---------- old phase: real 0.1.37 ----------
  server = run(oldServer); await initialize(server); await setupToReady(server);
  let rows = await index();
  assert(rows.includes('College email'), `precondition: 0.1.37 indexed the Berkeley-shape Notes item:\n${rows}`);
  assert(rows.includes('readme.txt'), `precondition: 0.1.37 indexed the file lying in the Applications folder (the bug):\n${rows}`);
  assert(sqlite(path.join(dataHome, 'moc', 'fts.db'), "SELECT count(*) FROM notes WHERE path LIKE '%College email%'") !== '0', 'precondition: in fts.db too');
  if (process.env.DBG) console.log('OLD PHASE .databrain:', (await fs.readdir(path.join(dataHome, '.databrain'))).join(' '));
  // the real 0.1.37 brain had NO /Applications rows in inventory.tsv (its walk of /Applications failed); the fake walk succeeds, so remove them to match the disk Tab 1 saw
  const inv = path.join(dataHome, 'moc', 'inventory.tsv');
  await fs.writeFile(inv, (await fs.readFile(inv, 'utf8')).split('\n').filter(l => !l.includes('readme.txt')).join('\n'));
  server.child.kill('SIGTERM'); await sleep(1500);

  // ---------- new phase: real 0.1.38, same HOME, items unchanged except one NEW item for the control ----------
  const callsBefore = await callCount();
  const UNCHANGED = process.env.G2_UNCHANGED === '1';   // variant: the app items are exactly as 0.1.37 saw them (no new item, no control)
  await fs.writeFile(fixture, JSON.stringify(UNCHANGED ? itemsOld : [...itemsOld, { i: 'x-3', t: 'Order mail', b: 'buyer@example.com\nreference A1B2C3D4', d: '2026-01-04T10:00:00Z', c: 'Home' }]));
  server = run(newServer); await initialize(server);
  // G3: health call 1, exactly as the user would see it
  const health1 = await server.tool('databrain_health');
  console.log('=== G3 HEALTH CALL 1 (0.1.38 on a 0.1.37 brain, before any refresh) ===\n' + health1 + '\n=== END ===');
  const verify1 = (await server.tool('databrain_verify_install')).split('\n').find(l => l.includes('Selected-source health'));
  console.log('G3 verify_install call 1: ' + verify1);
  await sleep(1500);
  const statusAfter1 = await server.tool('databrain_setup_status');
  console.log('=== STATUS 1.5 s after health call 1 ===\n' + statusAfter1.split('\n').slice(0, 8).join('\n') + '\n=== END ===');
  const refreshStartedByHealth = /Running now/.test(statusAfter1) || (await state()).indexJob?.status === 'running';
  console.log('G3 health call 1 started a refresh by itself:', refreshStartedByHealth);
  console.log(await server.tool('databrain_refresh'));
  await until(async () => (await state()).privacyRulesVersion === '0.1.38', 'rules version recorded', 180000);
  await idle(server);
  // privacy: pause for the held items? read the list and keep only the control item
  if (process.env.DBG) console.log('NEW PHASE .databrain:', (await fs.readdir(path.join(dataHome, '.databrain'))).join(' '));
  if (!UNCHANGED) {
    const list = await server.tool('databrain_privacy', { action: 'list' });
    console.log('=== privacy list ===\n' + list + '\n=== END ===');
    const orderLine = list.split('\n').find(line => line.includes('Order mail'));
    assert(orderLine, `the new Order mail item is held (email + token):\n${list}`);
    const heldName = orderLine.replace(/^[-*\s\d.]*/, '').split(/ [-—(]/)[0].trim();
    const decided = await server.tool('databrain_privacy', { action: 'decide', keep: [heldName] });
    console.log('decide reply:', decided.slice(0, 200));
    await idle(server);
    await server.tool('databrain_refresh'); await idle(server);
  } else { await server.tool('databrain_refresh'); await idle(server); }
  rows = await index();
  // G2
  assert(!rows.includes('College email'), `G2: the unchanged Berkeley-shape item is out of the index:\n${rows}`);
  assert.equal(sqlite(path.join(dataHome, 'moc', 'fts.db'), "SELECT count(*) FROM notes WHERE path LIKE '%College email%'"), '0', 'G2: out of fts.db');
  const grepMirror = (await fs.readdir(path.join(dataHome, 'app-content'), { recursive: true }).catch(() => [])).filter(f => String(f).includes('College'));
  assert.deepEqual(grepMirror, [], 'G2: out of the app-content mirror');
  assert(!(await server.tool('databrain_search', { query: 'c014d1' })).includes('College email'), 'G2: not searchable');
  assert(rows.includes('Garden plan'), 'G2 control: the ordinary item stays indexed');
  assert(UNCHANGED || rows.includes('Order mail'), `G2 control: the item the user kept through decide stays indexed:\n${rows}`);
  console.log('G2 stub osascript calls during the new phase:', (await callLines()).slice(callsBefore).join(' | '));
  // G3
  assert(!rows.includes('readme.txt'), `G3: the leftover Applications-folder row is gone:\n${rows}`);
  const verify2 = (await server.tool('databrain_verify_install')).split('\n').find(l => l.includes('Selected-source health'));
  console.log('G3 verify_install after refresh: ' + verify2);
  assert(/PASS: Selected-source health/.test(verify2), `G3: verify_install after the refresh passes: ${verify2}`);
  const health2 = await server.tool('databrain_health');
  console.log('=== G3 HEALTH AFTER REFRESH ===\n' + health2 + '\n=== END ===');
  assert(!/reported an issue/.test(health2) && /Source freshness: current/.test(health2), 'G3: health after the refresh reports no gap');
  console.log('PASS G2+G3');
} finally {
  server?.child.kill('SIGTERM');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
