// FOUR DataBrain servers started together on ONE brain (the Claude app does this after a restart: 3 at 17:24:21Z and 4 at 17:41:07Z on 2026-10-09).
// We cannot stop the app doing it, so the servers must tolerate it:
//   A) startup app check: exactly one 'app check' job (start and end), one read of the app, one refresh; the other servers log that they skipped;
//   B) startup resume of an interrupted indexing: the indexing runs once; the servers that waited for the lock find it finished and do nothing.
// Stub app and stub interpreter only.
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
const files = async () => { const out = []; const walk = async f => { for (const e of await fs.readdir(f, { withFileTypes: true }).catch(() => [])) { const full = path.join(f, e.name); if (e.isDirectory()) await walk(full); else if (!e.name.startsWith('.')) out.push(full); } }; await walk(mirror); return out; };
const fileWith = async marker => { for (const f of await files()) if ((await fs.readFile(f, 'utf8')).includes(marker)) return f; return null; };
const savedStage = async () => JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8')).stage;


const baseEnv = { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE: fixture, CALL_LOG: calls, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_FRESH_CAP_MS: '240000', DATABRAIN_TEST_LOCK_POLL_MS: '200' };
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
const LOCK_BUSY = /Another DataBrain job is indexing or changing this brain\. This is normal and ends by itself/;
// A job that found the brain locked by a sibling server says so in its own words ("normal and ends by itself"); that is the lock working, not a failure.
const failed = async () => (await timing()).filter(f => { const text = f.slice(3).join(' '); return /failed/.test(text) && !LOCK_BUSY.test(text); });
const servers = [];
const startMany = (count, env = {}) => { const list = Array.from({ length: count }, () => startServer(env)); servers.push(...list); return list; };
const count = async (kind, stage) => (await timing()).filter(f => f[1] === kind && f[3] === stage).length;
try {
  // ---- A) the app check ----
  const first = startServer(); servers.push(first); await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'setup reaches ready').catch(async error => { throw new Error(`${error.message}\n${(await first.tool('databrain_setup_status')).slice(0, 3000)}`); });
  await sleep(1500);
  first.child.kill('SIGKILL'); await sleep(1000);
  const hourAgo = new Date(Date.now() - 3600000);   // the report setup just wrote is made old, or the new servers rightly skip (it is under a minute old)
  await fs.utimes(path.join(dataHome, '.databrain', 'app-report.json'), hourAgo, hourAgo);
  // 300 more pages, so the app read writes many files in one go while a watcher looks at the folder (a page seen with a date other than its own
  // was seen half-written: the fingerprint changed after the text was in place; see test_mcp_mirror_atomic_write.mjs).
  const fillerDate = '2026-03-03T10:00:00Z';
  await write([row('x-1', 'First page', 'twinfirstmarker stays', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'twinfreshmarker is new while all four start', '2026-02-02T10:00:00Z'),
    ...Array.from({ length: 300 }, (_, i) => row(`f-${i}`, `Filler ${i}`, `twinfiller${i} ${'text '.repeat(100)}`, fillerDate))]);
  const allowedDates = ['2026-01-01T10:00:00Z', '2026-01-02T10:00:00Z', '2026-01-03T10:00:00Z', '2026-02-02T10:00:00Z', fillerDate].map(d => Date.parse(d));
  const watcher = spawn(process.execPath, ['-e', `const fs=require('fs'),path=require('path');const dir=process.argv[1],ok=JSON.parse(process.argv[2]);let bad=0,seen=0;const done=new Set();process.stdin.on('data',()=>{console.log(JSON.stringify({bad,seen}));process.exit(0)});(function loop(){let n=[];try{n=fs.readdirSync(dir)}catch{}for(const f of n){if(!f.endsWith('.md')||done.has(f))continue;try{const i=fs.statSync(path.join(dir,f));seen++;if(!ok.some(t=>Math.abs(i.mtimeMs-t)<1))bad++;else done.add(f)}catch{}}setTimeout(loop,1)})()`, path.join(mirror, 'Home'), JSON.stringify(allowedDates)], { stdio: ['pipe', 'pipe', 'inherit'] });
  let watcherOut = ''; watcher.stdout.on('data', d => { watcherOut += d; });
  servers.push({ child: watcher });
  // An engine step of another process is still running when the four start (a command line that holds the engine path): the start-up read of
  // the apps must wait for it and still happen exactly once (see test_mcp_app_check_deferred.mjs).
  const engineDir = path.resolve(path.dirname(serverScript), '../..');
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)', path.join(engineDir, 'bin', 'decoy-engine-step')], { stdio: 'ignore' });
  servers.push({ child: decoy });
  await fs.writeFile(calls, '');
  const checksBefore = await count('app check', 'job-start');
  const refreshesBefore = await jobStarts('refresh');
  const four = startMany(4, { DATABRAIN_TEST_UPDATE_DELAY_MS: '3000' });
  await Promise.all(four.map(s => s.ready));
  const dumpNow = async () => `\ncalls: ${(await log()).join(' | ')}\n${(await timing()).slice(-30).map(f => f.join(' ')).join('\n')}`;
  await until(async () => (await fileWith('twinfreshmarker')) !== null, 'the new page is mirrored', 360000).catch(async error => { throw new Error(`${error.message}${await dumpNow()}`); });
  await until(async () => (await timing()).some(f => f[1] === 'refresh' && f[3] === 'job-end'), 'the refresh ends', 360000).catch(async error => { throw new Error(`${error.message}${await dumpNow()}`); });
  await sleep(6000);   // time for a (wrong) second app check, read or refresh to show itself
  const dump = async () => `\ncalls: ${(await log()).join(' | ')}\n${(await timing()).slice(-30).map(f => f.join(' ')).join('\n')}`;
  watcher.stdin.write('stop\n'); await new Promise(resolve => watcher.on('close', resolve));
  const watched = JSON.parse(watcherOut.trim().split('\n').pop() || '{}');
  assert(watched.seen > 0 && watched.bad === 0, `no mirrored page was seen with a half-finished date: ${watcherOut}`);
  assert.equal((await count('app check', 'job-start')) - checksBefore, 1, `exactly one app check starts${await dump()}`);
  assert.equal((await count('app check', 'job-end')) - checksBefore, 1, 'and exactly one ends');
  const skipped = (await timing()).filter(f => f[3] === 'app-check-skipped');
  assert(skipped.every(f => /another client/.test(f[5] || '')), `a server that skipped says why: ${JSON.stringify(skipped)}`);   // a server that starts after the check finished has nothing to skip and logs nothing
  assert.deepEqual((await log()).filter(l => l === 'full' || l === 'dates'), ['full'], `four servers, ONE read of the app: ${JSON.stringify(await log())}`);
  assert.equal((await jobStarts('refresh')) - refreshesBefore, 1, 'exactly one refresh');
  assert.deepEqual(await failed(), [], `no job failed:\n${(await failed()).map(f => f.join(' ')).join('\n')}`);
  const pids = (await timing()).filter(f => f[3] === 'server-start').map(f => (f[5].match(/pid=(\d+)/) || [])[1]).slice(-4);
  assert(pids.length === 4 && new Set(pids).size === 4, `all four servers really started: ${pids}`);
  assert(/From your files: Datebook > Home > Second page/.test(await four[3].tool('databrain_search', { query: 'twinfreshmarker' })), 'the new page is searchable');
  for (const s of four) s.child.kill('SIGKILL');
  await sleep(1000);

  // ---- B) resuming an interrupted indexing ----
  const folder = path.join(temp, 'ResumeFolder'); await fs.mkdir(folder, { recursive: true });
  const realFolder = await fs.realpath(folder);
  for (let i = 1; i <= 3; i++) await fs.writeFile(path.join(realFolder, `r${i}.md`), `# R${i}\nresumemarker${i} text.\n`);
  const home2 = path.join(temp, 'home2'); await fs.mkdir(home2, { recursive: true });
  const dataHome2 = path.join(home2, 'DataBrain');
  const timing2 = async () => (await fs.readFile(path.join(dataHome2, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => l.split('\t'));
  const stage2 = async () => JSON.parse(await fs.readFile(path.join(dataHome2, '.databrain', 'desktop-state.json'), 'utf8')).stage;
  const spawn2 = env => {
    const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realFolder], { env: { ...process.env, HOME: home2, DATABRAIN_FRESHNESS_CHECK_MS: '100', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map(); let k = 0;
    readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
    const ask = (method, params) => new Promise(resolve => { const id = ++k; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
    const ready = ask('initialize', { protocolVersion: '2025-03-26' }).then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
    servers.push({ child });
    return { child, tool, ready };
  };
  const dying = spawn2({ DATABRAIN_TEST_INDEX_DELAY_MS: '120000' }); await dying.ready;
  await dying.tool('databrain_setup_start');
  await until(async () => /Running now: initial indexing/.test(await dying.tool('databrain_setup_status')), 'the first indexing is running');
  dying.child.kill('SIGKILL'); await sleep(1000);
  assert.equal(await stage2(), 'indexing', 'the indexing was interrupted');
  const indexBuilds = async () => (await timing2()).filter(f => f[1] === 'initial indexing' && f[3] === 'engine:build-fts.sh').length;
  const buildsBefore = await indexBuilds();
  const wave = Array.from({ length: 4 }, () => spawn2({ DATABRAIN_TEST_INDEX_DELAY_MS: '2000' }));
  await Promise.all(wave.map(s => s.ready));
  await until(async () => (await stage2().catch(() => 'indexing')) !== 'indexing', 'the resumed indexing finishes by itself', 120000);
  await sleep(8000);   // time for a (wrong) second full indexing by a server that waited for the lock
  const builds = (await indexBuilds()) - buildsBefore;
  const dump2 = async () => `\n${(await timing2()).slice(-40).map(f => f.join(' ')).join('\n')}`;
  assert.equal(builds, 1, `the resumed indexing ran ONCE across four servers (build-fts runs: ${builds})${await dump2()}`);
  // (A server that starts after the work is done has nothing to build and may log nothing; the promise is the single build-fts run asserted above.)
  assert.deepEqual((await timing2()).filter(f => { const text = f.slice(3).join(' '); return /failed/.test(text) && !LOCK_BUSY.test(text); }), [], `no job failed${await dump2()}`);
  console.log('PASS: four servers started together (an engine step still running): one app check, one read, one refresh, no page seen half-written; an interrupted indexing resumed by all four runs once.');
} finally {
  for (const s of servers) s.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
