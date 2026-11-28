// The one read of the apps at start must not be lost when an engine step of another process is still running at that moment.
// (2026-10-11: four servers started together, an engine step was still alive, the start-up read returned silently and never came back,
// so a page changed in the app stayed out of the index.) A decoy process whose command line holds the engine path plays that engine step.
// Expected: the server says once that it is waiting ('app-check-deferred'), and when the decoy ends the app check runs by itself.
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
const files = async () => { const out = []; const walk = async f => { for (const e of await fs.readdir(f, { withFileTypes: true }).catch(() => [])) { const full = path.join(f, e.name); if (e.isDirectory()) await walk(full); else out.push(full); } }; await walk(mirror); return out; };
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
const failed = async () => (await timing()).filter(f => /failed/.test(f.slice(3).join(' ')));
const count = async (kind, stage) => (await timing()).filter(f => f[1] === kind && f[3] === stage).length;
const servers = [];
try {
  const first = startServer(); servers.push(first); await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'setup reaches ready');
  await sleep(1500);
  first.child.kill('SIGKILL'); await sleep(1000);
  const hourAgo = new Date(Date.now() - 3600000);
  await fs.utimes(path.join(dataHome, '.databrain', 'app-report.json'), hourAgo, hourAgo);
  await write([row('x-1', 'First page', 'twinfirstmarker stays', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'twinfreshmarker is new', '2026-02-02T10:00:00Z')]);
  await fs.writeFile(calls, '');
  const checksBefore = await count('app check', 'job-start');
  const refreshEndsBefore = await count('refresh', 'job-end');
  const engineDir = path.resolve(path.dirname(serverScript), '../..');
  const decoyMs = 9000;
  const decoy = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${decoyMs})`, path.join(engineDir, 'bin', 'decoy-engine-step')], { stdio: 'ignore' });
  await sleep(500);
  const decoyStarted = Date.now();
  const server = startServer(); servers.push(server); await server.ready;
  await until(async () => (await timing()).some(f => f[3] === 'app-check-deferred'), 'the server says it is waiting for the running engine step', 8000);
  assert.equal((await count('app check', 'job-start')) - checksBefore, 0, 'no app check while the engine step runs');
  assert.equal(await fileWith('twinfreshmarker'), null, 'and the new page is not mirrored yet');
  await until(async () => (await fileWith('twinfreshmarker')) !== null, 'the new page is mirrored after the engine step ended', 40000).catch(async error => { throw new Error(`${error.message}\n${(await timing()).slice(-12).map(f => f.join(' ')).join('\n')}`); });
  assert(Date.now() - decoyStarted >= decoyMs - 1500, 'and not before the engine step ended');
  assert.equal((await count('app check', 'job-start')) - checksBefore, 1, 'exactly one app check');
  assert.equal((await timing()).filter(f => f[3] === 'app-check-deferred').length, 1, 'the waiting is said once, not every pass');
  await until(async () => (await count('refresh', 'job-end')) > refreshEndsBefore, 'the refresh the app check started ends', 60000);
  assert(/From your files: Datebook > Home > Second page/.test(await server.tool('databrain_search', { query: 'twinfreshmarker' })), 'the new page is searchable');
  console.log('PASS: with an engine step still running at start, the server says it waits once, then reads the apps by itself when the step ends: one app check, new page mirrored and searchable.');
} finally {
  for (const s of servers) s.child.kill('SIGKILL');
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
