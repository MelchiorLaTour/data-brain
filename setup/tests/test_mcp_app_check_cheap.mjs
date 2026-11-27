// Every new chat starts a DataBrain server and so an "app check". Measured on a real brain: 25 s to 9 min, because the check read every Notes and
// Reminders body again. With ~400 invented pages: (1) the check after a restart asks for dates only and finishes quickly, with its stages
// logged; (2) two servers started together on one brain ask the app once; (3) a note is saved and confirmed within seconds while the check runs.
// Stub app and stub interpreter only. A "full read" of the stub takes FULL_DELAY_MS, like the minutes of the real one.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-twin-')));
const home = path.join(temp, 'home');
await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\ntwinsteadymarker an ordinary note.\n');
// a dictionary with its own vocabulary: class "page" (plural "pages"), properties title / text / id / modification date / container / locked
const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
const bundle = path.join(appsDir, 'Datebook.app', 'Contents');
await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
await fs.writeFile(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.datebook</string><key>CFBundleName</key><string>Datebook</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>');
await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);

const fixture = path.join(temp, 'fixture.json'); const calls = path.join(temp, 'calls.log');
const row = (i, t, b, d, extra = {}) => ({ i, t, b, d, c: 'Home', ...extra });
const write = rows => fs.writeFile(fixture, JSON.stringify(rows));
await write(Array.from({ length: process.env.DATABRAIN_TEST_CLIENT === 'chatgpt' ? 40 : 400 }, (_, n) => row(`x-${n}`, `Page ${n}`, `checkmarker${n} invented text of page ${n}`, `2026-01-01T10:${String(n % 60).padStart(2, '0')}:00Z`)));
const stub = path.join(temp, 'interpreter-stub.mjs');
await fs.writeFile(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const script = process.argv[5];
const rows = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
const log = line => fs.appendFileSync(process.env.CALL_LOG, line + '\\n');
const nap = ms => new Promise(r => setTimeout(r, ms));
const need = (...needles) => { for (const n of needles) if (!script.includes(n)) { console.error('missing ' + n); process.exit(2); } };
if (script.includes('// dates only')) { need('app.pages', 'c.id()', 'c.modificationDate()'); if (/c\\.text\\(\\)|c\\.title\\(\\)/.test(script)) { console.error('a dates-only question must not ask for text or titles'); process.exit(3); } log('dates'); await nap(Number(process.env.DATES_DELAY_MS || 0)); console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) })); }
else if (script.includes('// fetch by id')) { need('c.byId(id)', 'it.title()', 'it.text()', 'it.modificationDate()', 'it.locked()'); const ids = JSON.parse(script.match(/for \\(const id of (\\[.*?\\])\\)/)[1]); log('fetch ' + ids.join(',')); console.log(JSON.stringify(rows.filter(r => ids.includes(r.i)))); }
else if (script.includes('// full read')) { need('app.pages', 'c.title()', 'c.text()', 'c.id()'); log('full'); await nap(Number(process.env.FULL_DELAY_MS || 0)); console.log(JSON.stringify(rows)); }
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });

const dataHome = path.join(home, 'DataBrain');
const mirror = path.join(dataHome, 'app-content', 'Datebook');
const log = async () => (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const files = async () => { const out = []; const walk = async f => { for (const e of await fs.readdir(f, { withFileTypes: true }).catch(() => [])) { const full = path.join(f, e.name); if (e.isDirectory()) await walk(full); else out.push(full); } }; await walk(mirror); return out; };
const fileWith = async marker => { for (const f of await files()) if ((await fs.readFile(f, 'utf8')).includes(marker)) return f; return null; };
const savedStage = async () => JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8')).stage;


const baseEnv = { ...process.env, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300', HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE: fixture, CALL_LOG: calls, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_FRESH_CAP_MS: '240000', DATABRAIN_TEST_LOCK_POLL_MS: '200' };
let n = 0;
function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], { env: { ...baseEnv, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, tool, ready };
}
const timing = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => l.split('\t'));
const jobStarts = async kind => (await timing()).filter(f => f[1] === kind && f[3] === 'job-start').length;
const failed = async () => (await timing()).filter(f => /failed/.test(f.slice(3).join(' ')));
const msOf = async (kind, stage) => (await timing()).filter(f => f[1] === kind && f[3] === stage).map(f => Number(String(f[4]).replace('ms', '')));
const servers = [];
try {
  // setup: the first read of the app is a full one (slow, like the real one)
  const first = startServer({ FULL_DELAY_MS: '6000' }); servers.push(first); await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'setup reaches ready', 600000).catch(async error => { throw new Error(`${error.message}\n${await first.tool('databrain_setup_status')}`); });
  await sleep(1500);
  assert.equal((await log()).filter(l => l === 'full').length, 1, 'setup reads the app once, in full');
  first.child.kill('SIGKILL'); await sleep(1000);
  const old = new Date(Date.now() - 3600000);
  const ageReport = () => fs.utimes(path.join(dataHome, '.databrain', 'app-report.json'), old, old);

  // 1) a new chat = a new server, nothing changed in the app: dates only, finished within LIMIT
  await fs.writeFile(calls, ''); await ageReport();
  const LIMIT_MS = 5000;   // the stub answers at once, so the check is a few engine starts plus the freshness scan; a full read here takes 6 s (FULL_DELAY_MS) and would fail this
  const s1 = startServer({ FULL_DELAY_MS: '6000' }); servers.push(s1); await s1.ready;
  await until(async () => (await msOf('app check', 'job-end')).length === 1, 'the app check ends', 60000);
  const [took] = await msOf('app check', 'job-end');
  assert(took < LIMIT_MS, `the app check took ${took} ms (limit ${LIMIT_MS}); stages:\n${(await timing()).filter(f => f[3].startsWith('app')).map(f => f.slice(3).join(' ')).join('\n')}`);
  assert.equal((await log()).filter(l => l === 'full').length, 0, `no full read of the bodies: ${JSON.stringify(await log())}`);
  assert((await log()).filter(l => l === 'dates').length >= 1, 'the app was asked for dates');
  const stages = (await timing()).map(f => f[3]);
  for (const name of ['app-dates-check', 'app-check:apps', 'app-check:freshness']) assert(stages.includes(name), `the check logs ${name}: ${stages.join(', ')}`);
  console.log(`  app check after a restart: ${took} ms, dates only`);
  s1.child.kill('SIGKILL'); await sleep(800);

  // 2) two servers start together on one brain, the last read being 5 s old (default recency 60 s): the app is asked once
  await fs.writeFile(calls, '');
  const recent = new Date(Date.now() - 5000); await fs.utimes(path.join(dataHome, '.databrain', 'app-report.json'), recent, recent);
  // the recency window is widened to 10 minutes so that a slow start on a loaded machine (the ChatGPT suite took long once) cannot age the read past it; the rule under test is unchanged
  const a = startServer({ DATABRAIN_TEST_APP_RECENT_MS: '600000' }); const b = startServer({ DATABRAIN_TEST_APP_RECENT_MS: '600000' }); servers.push(a, b); await Promise.all([a.ready, b.ready]);
  await sleep(4000);
  assert.equal((await log()).filter(l => l === 'dates').length, 0, `a read that is 5 s old is not repeated by two new servers: ${JSON.stringify(await log())}`);
  await until(async () => (await timing()).filter(f => f[3] === 'app-check-skipped').length >= 1, 'the skip is logged', 30000);
  assert.equal((await log()).filter(l => l === 'dates').length, 0, 'and the app was still not asked');
  a.child.kill('SIGKILL'); b.child.kill('SIGKILL'); await sleep(800);

  // 2b) two servers start together, the last read is an hour old: ONE of them asks the app, the other finds the read just made and skips
  await ageReport(); await fs.writeFile(calls, '');
  const skippedBefore = (await timing()).filter(f => f[3] === 'app-check-skipped').length;
  const e = startServer(); const f2 = startServer(); servers.push(e, f2); await Promise.all([e.ready, f2.ready]);
  await until(async () => (await timing()).filter(f => f[3] === 'app-check-skipped').length > skippedBefore, 'the second server skips its check', 60000);
  await sleep(3000);
  assert.equal((await log()).filter(l => l === 'dates').length, 1, `two servers started together, one real app check: ${JSON.stringify(await log())}`);
  assert.equal((await log()).filter(l => l === 'full').length, 0, 'and no full read');
  e.child.kill('SIGKILL'); f2.child.kill('SIGKILL'); await sleep(800);

  // 2c) a page edited in the app (new modification date): only that page is fetched, not the 400
  await ageReport(); await fs.writeFile(calls, '');
  const rows = JSON.parse(await fs.readFile(fixture, 'utf8')); rows[5] = { ...rows[5], b: 'checkeditedmarker the edited page', d: '2026-03-03T10:00:00Z' };
  await write(rows);
  const g = startServer(); servers.push(g); await g.ready;
  await until(async () => (await log()).some(l => l.startsWith('fetch')), 'the edited page is fetched', 60000);
  await sleep(1500);
  assert.deepEqual((await log()).filter(l => l !== 'dates'), ['fetch x-5'], `a changed page is fetched alone, never a full read: ${JSON.stringify(await log())}`);
  await until(async () => (await fileWith('checkeditedmarker')) !== null, 'the edited page is mirrored', 30000);
  g.child.kill('SIGKILL'); await sleep(800);

  // 3) a note is saved and confirmed within seconds while a slow app check runs
  await ageReport(); await fs.writeFile(calls, '');
  const starts = (await timing()).filter(f => f[1] === 'app check' && f[3] === 'job-start').length;
  const c = startServer({ DATES_DELAY_MS: '12000' }); servers.push(c); await c.ready;
  await until(async () => (await timing()).filter(f => f[1] === 'app check' && f[3] === 'job-start').length > starts, 'the app check is running', 30000);
  const saveStarted = Date.now();
  const saved = await c.tool('databrain_capture', { title: 'During the check', body: 'checksavedmarker a note written while the app check runs.', folder: realDocs, keywords: ['check-save', 'app-check'] });
  const saveMs = Date.now() - saveStarted;
  assert(/Saved/.test(saved), `the note is saved: ${saved}`);
  assert(saveMs < 5000, `the save was confirmed after ${saveMs} ms while the app check ran`);
  console.log(`  note save during an app check: ${saveMs} ms`);
  // the note job itself holds the brain's lock only for the index steps the note needs; the maps and the inventory (about two minutes on a real brain) are the housekeeping job's
  await until(async () => (await timing()).some(f => f[1] === 'note write' && f[3] === 'job-end'), 'the note job ends', 60000);
  const noteStages = (await timing()).filter(f => f[1] === 'note write').map(f => f[3]);
  assert(noteStages.includes('engine:index-add.sh') && noteStages.includes('engine:build-fts.sh'), `the note job adds the note and refreshes search: ${noteStages.join(', ')}`);
  assert(!noteStages.includes('engine:inventory.sh') && !noteStages.includes('engine:rebuild.sh'), `the note job does not run the inventory or the maps: ${noteStages.join(', ')}`);
  await until(async () => (await timing()).some(f => f[1] === 'index housekeeping' && f[3] === 'job-end'), 'housekeeping redraws them afterwards', 90000);
  await until(async () => (await fs.stat(path.join(dataHome, 'moc', 'relationships.tsv')).then(info => info.size > 0, () => false)), 'the report that follows the note is built', 120000);
  c.child.kill('SIGKILL'); await sleep(800);

  // 4) another DataBrain program holds the brain's lock for a while: the relationship report waits and then builds; none of its jobs fails
  //    5) and repair says plainly that it waits and finishes by itself, with nothing listed as still wrong
  const lockFile = path.join(dataHome, '.databrain', 'index-worker-lock.sqlite');
  const holder = spawn('/usr/bin/sqlite3', ['-batch', '-bail', lockFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  holder.stdin.write("BEGIN EXCLUSIVE;\nSELECT 'held';\n");
  await sleep(800);
  const relFile = path.join(dataHome, 'moc', 'relationships.tsv');
  await fs.rm(relFile, { force: true });
  const failuresBefore = (await failed()).length;
  const d = startServer({ DATABRAIN_TEST_REPAIR_WAIT_MS: '3000' }); servers.push(d); await d.ready;
  await d.tool('databrain_setup_status');   // notices the missing report and schedules one
  await sleep(2500);
  const repair = await d.tool('databrain_repair');
  assert(/Waiting, not failed/.test(repair), `repair says it waits and finishes by itself:\n${repair}`);
  assert(/Still wrong: nothing\./.test(repair), `repair lists nothing as still wrong while another program holds the lock:\n${repair}`);
  assert.equal((await failed()).length, failuresBefore, `no job failed while the lock was held:\n${(await failed()).slice(failuresBefore).map(f => f.join(' ')).join('\n')}`);
  holder.stdin.end('ROLLBACK;\n.quit\n');
  await until(async () => (await fs.stat(relFile).then(info => info.size > 0, () => false)), 'the relationship report is built after the lock is free', 120000).catch(async error => { throw new Error(`${error.message}\n${(await timing()).slice(-25).map(f => f.join(' ')).join('\n')}`); });
  assert.equal((await failed()).length, failuresBefore, 'still no failed job');
  console.log('  relationship report and repair while another program held the lock: waited, nothing failed');
  console.log('PASS: the app check after a restart asks for dates only (with its stages logged) and finishes in seconds; two servers started together ask the app once; a note is saved and confirmed in seconds while the check runs.');
} finally {
  for (const s of servers) s.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
