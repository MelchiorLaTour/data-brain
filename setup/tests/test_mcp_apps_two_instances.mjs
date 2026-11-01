// Two DataBrain server instances on ONE brain, started together (a second Claude window, a restarted extension). Exactly one read of each app,
// exactly one refresh, the items end up indexed, no job fails; and a refresh that finds the index lock busy waits for it instead of failing,
// then does nothing because the other one already brought the index up to date. Stub app and stub interpreter only.
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
await write([row('x-1', 'First page', 'twinfirstmarker stays untouched', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'twinsecondmarker before the edit', '2026-01-02T10:00:00Z'), row('x-3', 'Third page', 'twinthirdmarker will be deleted', '2026-01-03T10:00:00Z')]);
const stub = path.join(temp, 'interpreter-stub.mjs');
await fs.writeFile(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const script = process.argv[5];
const rows = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
const log = line => fs.appendFileSync(process.env.CALL_LOG, line + '\\n');
const need = (...needles) => { for (const n of needles) if (!script.includes(n)) { console.error('missing ' + n); process.exit(2); } };
if (script.includes('// dates only')) { need('app.pages', 'c.id()', 'c.modificationDate()'); if (/c\\.text\\(\\)|c\\.title\\(\\)/.test(script)) { console.error('a dates-only question must not ask for text or titles'); process.exit(3); } log('dates'); console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) })); }
else if (script.includes('// fetch by id')) { need('c.byId(id)', 'it.title()', 'it.text()', 'it.modificationDate()', 'it.locked()'); const ids = JSON.parse(script.match(/for \\(const id of (\\[.*?\\])\\)/)[1]); log('fetch ' + ids.join(',')); console.log(JSON.stringify(rows.filter(r => ids.includes(r.i)))); }
else if (script.includes('// full read')) { need('app.pages', 'c.title()', 'c.text()', 'c.id()'); log('full'); console.log(JSON.stringify(rows)); }
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });

const dataHome = path.join(home, 'DataBrain');
const mirror = path.join(dataHome, 'app-content', 'Datebook');
const log = async () => (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const files = async () => { const out = []; const walk = async f => { for (const e of await fs.readdir(f, { withFileTypes: true }).catch(() => [])) { const full = path.join(f, e.name); if (e.isDirectory()) await walk(full); else out.push(full); } }; await walk(mirror); return out; };
const fileWith = async marker => { for (const f of await files()) if ((await fs.readFile(f, 'utf8')).includes(marker)) return f; return null; };
const savedStage = async () => JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8')).stage;


const baseEnv = { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, DATABRAIN_TEST_APP_RECENT_MS: '0', FIXTURE: fixture, CALL_LOG: calls, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_FRESH_CAP_MS: '240000', DATABRAIN_TEST_LOCK_POLL_MS: '200' };
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
const servers = [];
try {
  // setup with one instance: the first read is one full read
  const first = startServer(); servers.push(first); await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'setup reaches ready').catch(async error => { throw new Error(`${error.message}\n${(await first.tool('databrain_setup_status')).slice(0, 3000)}`); });
  await sleep(1500);
  assert.equal((await log()).filter(l => l === 'full').length, 1, 'setup reads the app once');
  first.child.kill('SIGKILL'); await sleep(1000);

  // 1) a page appears; two instances start together
  await write([row('x-1', 'First page', 'twinfirstmarker stays', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'twinfreshmarker is new while both start', '2026-02-02T10:00:00Z')]);
  await fs.writeFile(calls, '');
  const refreshesBefore = await jobStarts('refresh');
  const a = startServer({ DATABRAIN_TEST_UPDATE_DELAY_MS: '3000' }); const b = startServer({ DATABRAIN_TEST_UPDATE_DELAY_MS: '3000' }); servers.push(a, b);
  await Promise.all([a.ready, b.ready]);
  await until(async () => (await fileWith('twinfreshmarker')) !== null, 'the new page is mirrored');
  await until(async () => (await jobStarts('refresh')) > refreshesBefore, 'a refresh starts', 60000).catch(async error => { throw new Error(`${error.message}\ncalls: ${(await log()).join(' | ')}\n${(await timing()).slice(-25).map(f => f.join(' ')).join('\n')}\n${(await a.tool('databrain_setup_status')).slice(0, 2500)}`); });
  await until(async () => (await timing()).some(f => f[1] === 'refresh' && f[3] === 'job-end'), 'the refresh ends');
  await sleep(6000);   // time for a (wrong) second read or second refresh to show itself
  const reads = (await log()).filter(l => l === 'full' || l === 'dates');
  assert.deepEqual(reads, ['full'], `two instances, ONE read of the app: ${JSON.stringify(await log())}`);
  assert.equal((await jobStarts('refresh')) - refreshesBefore, 1, 'exactly one refresh');
  assert.deepEqual(await failed(), [], `no job failed:\n${(await failed()).map(f => f.join(' ')).join('\n')}`);
  // every start leaves one line with its pid, so two servers on one brain show up as two pids
  const starts = (await timing()).filter(f => f[3] === 'server-start');
  const pids = starts.map(f => (f[5].match(/pid=(\d+)/) || [])[1]);
  assert(starts.length >= 2 && pids.every(Boolean) && new Set(pids).size === starts.length, `one server-start line per process, all pids different: ${JSON.stringify(starts.map(f => f.slice(3)))}`);
  assert(starts.every(f => /version=\d+\.\d+\.\d+ bundle=\S+/.test(f[5])), 'the line carries the version and the bundle path');   // the first server started before the brain folder existed, so it could not log yet
  const startPids = (await timing()).filter(f => f[3] === 'job-start' && f[1] !== '-').map(f => (f[5] || '').match(/pid=(\d+)/)?.[1]);
  assert(startPids.length > 0 && startPids.every(Boolean), 'every job start carries the pid of the server that ran it');
  assert(startPids.filter(pid => pids.includes(pid)).length > 0, 'and those pids are the ones in the server-start lines');
  const status = await a.tool('databrain_setup_status');
  assert(!/being added/.test(status) && /Stage: ready/.test(status), `all indexed, status ready:\n${status}`);
  assert(/From your files: Datebook > Home > Second page/.test(await b.tool('databrain_search', { query: 'twinfreshmarker' })), 'the new page is searchable');

  // 2) a refresh that finds the index lock busy waits, then does nothing because the other one already finished
  await sleep(300);
  await write([row('x-1', 'First page', 'twinfirstmarker stays', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'twinfreshmarker is new while both start', '2026-02-02T10:00:00Z'), row('x-3', 'Third page', 'twinthirdmarker added later', '2026-03-03T10:00:00Z')]);
  const startsBefore = await jobStarts('refresh');
  const ranBefore = await (async () => new Set((await timing()).filter(f => f[1] === 'refresh' && f[3] === 'engine:build-fts.sh').map(f => f[2])).size)();
  const slow = a.tool('databrain_search', { query: 'twinthirdmarker' });          // a: reads the app, refreshes (3 s)
  await until(async () => (await jobStarts('refresh')) > startsBefore, 'the first refresh is running');
  const other = await b.tool('databrain_search', { query: 'twinthirdmarker' });    // b: finds the index lock busy
  await slow;
  await sleep(1500);
  assert(/From your files: Datebook > Home > Third page/.test(other) || /From your files: Datebook > Home > Third page/.test(await b.tool('databrain_search', { query: 'twinthirdmarker' })), 'the page is found through the second instance');
  assert.deepEqual(await failed(), [], `still no failed job:\n${(await failed()).map(f => f.join(' ')).join('\n')}`);
  const ranIndex = async () => new Set((await timing()).filter(f => f[1] === 'refresh' && f[3] === 'engine:build-fts.sh').map(f => f[2])).size;
  assert.equal((await ranIndex()) - ranBefore, 1, 'two refreshes asked for together became one: the one that waited had nothing left to do');
  assert((await timing()).some(f => f[1] === 'refresh' && f[3] === 'refresh-skipped'), `the one that waited logs refresh-skipped:\n${(await timing()).slice(-20).map(f => f.join(' ')).join('\n')}`);

  // 3) mirrored app content with no index rows yet is never called ready
  a.child.kill('SIGKILL'); b.child.kill('SIGKILL'); await sleep(1000);
  const d = startServer({ DATABRAIN_FRESHNESS_CHECK_MS: '600000' }); servers.push(d); await d.ready;
  await d.tool('databrain_setup_status');   // uses up the one freshness check, so the next status does not index first
  await fs.mkdir(path.join(mirror, 'Home'), { recursive: true });
  await fs.writeFile(path.join(mirror, 'Home', 'Stray page.md'), '# Stray page\ntwinstraymarker mirrored but not indexed yet.\n');
  const adding = await d.tool('databrain_setup_status');
  assert(/Your Datebook is being added/.test(adding) && !/Stage: ready/.test(adding), `status must not say ready while app content is not indexed:\n${adding}`);
  await until(async () => !/being added/.test(await d.tool('databrain_setup_status')), 'the stray page gets indexed by itself', 90000);
  console.log('PASS: two instances on one brain: one read per app, one refresh, everything indexed, nothing failed; a busy index lock is waited for; app content not yet indexed is never called ready.');
} finally {
  for (const s of servers) s.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
