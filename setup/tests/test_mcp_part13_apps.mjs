// Part 13 (0.2.1), items 3 and 4: an app check that finds an item it cannot fetch, or dates written another way, must not start a refresh; Reminders must not
// say "updated" every day; a question that never answers ends the check with a logged reason. (Header copied from the part 12 test.) Part 12 text: every question said "DataBrain is still indexing recent changes" although nothing was being indexed (a routine date check of Notes
// and Reminders that had not answered yet counted as a change). Also: a search must answer fast while that check runs; one changed item refreshes
// fast; a failed or killed app check ends with a logged reason and never blocks the next. Stand-in apps and invented data only.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-part13apps-')));
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
await write(Array.from({ length: 60 }, (_, n) => row(`x-${n}`, `Page ${n}`, `checkmarker${n} invented text of page ${n}`, `2026-01-01T10:${String(n % 60).padStart(2, '0')}:00Z`)));
const stub = path.join(temp, 'interpreter-stub.mjs');
await fs.writeFile(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const script = process.argv[5];
const rows = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
const log = line => fs.appendFileSync(process.env.CALL_LOG, line + '\\n');
const nap = ms => new Promise(r => setTimeout(r, ms));
const need = (...needles) => { for (const n of needles) if (!script.includes(n)) { console.error('missing ' + n); process.exit(2); } };
if (script.includes('// dates only')) { need('app.pages', 'c.id()', 'c.modificationDate()'); if (/c\\.text\\(\\)|c\\.title\\(\\)/.test(script)) { console.error('a dates-only question must not ask for text or titles'); process.exit(3); } log('dates'); if (fs.existsSync(process.env.FAIL_FILE)) { await nap(500); console.error('simulated: Reminders got an error: the app is not responding (-609)'); process.exit(1); } await nap(Number(fs.existsSync(process.env.DELAY_FILE) ? fs.readFileSync(process.env.DELAY_FILE, 'utf8') : 0) || 0); console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) })); }
else if (script.includes('// fetch by id')) { need('c.byId(id)', 'it.title()', 'it.text()', 'it.modificationDate()', 'it.locked()'); const ids = JSON.parse(script.match(/for \\(const id of (\\[.*?\\])\\)/)[1]); log('fetch ' + ids.join(',')); await nap(Number(fs.existsSync(process.env.FETCH_DELAY_FILE) ? fs.readFileSync(process.env.FETCH_DELAY_FILE, 'utf8') : 0) || 0); const unf = fs.existsSync(process.env.UNFETCH_FILE) ? JSON.parse(fs.readFileSync(process.env.UNFETCH_FILE, 'utf8')) : []; console.log(JSON.stringify(rows.filter(r => ids.includes(r.i) && !unf.includes(r.i)))); }
else if (script.includes('// full read')) { need('app.pages', 'c.title()', 'c.text()', 'c.id()'); log('full'); await nap(Number(process.env.FULL_DELAY_MS || 0)); console.log(JSON.stringify(rows)); }
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });

const DOCS = 20;
for (let k = 0; k < DOCS; k++) await fs.writeFile(path.join(realDocs, `note-${k}.md`), `# Note ${k}\nfalsewarnmarker${k} an invented note number ${k} about nothing real.\n`);

const delayFile = path.join(temp, 'dates-delay.txt'); const failFile = path.join(temp, 'fail-now');
await fs.writeFile(delayFile, '0');
const dataHome = path.join(home, 'DataBrain');
const log = async () => (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const baseEnv = { ...process.env, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300', HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE: fixture, CALL_LOG: calls, DELAY_FILE: delayFile, FETCH_DELAY_FILE: path.join(temp, 'fetch-delay.txt'), FAIL_FILE: failFile, UNFETCH_FILE: path.join(temp, 'unfetch.json'), DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_APP_RECENT_MS: '0', DATABRAIN_TEST_LOCK_POLL_MS: '200' };
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
const stage = async name => (await timing()).filter(f => f[3] === name);
const timed = async work => { const t0 = Date.now(); const value = await work(); return { value, ms: Date.now() - t0 }; };
const settle = async () => { await until(async () => { const rows = await timing(); return ['index housekeeping', 'refresh', 'app check', 'note write'].every(kind => rows.filter(f => f[1] === kind && f[3] === 'job-start').length === rows.filter(f => f[1] === kind && f[3] === 'job-end').length); }, 'jobs settle', 240000); await sleep(500); };
const BEING_ADDED = /New changes are being added/;
const setStaleReport = async () => { const old = new Date(Date.now() - 3600000); await fs.utimes(path.join(dataHome, '.databrain', 'app-report.json'), old, old); };
const servers = [];
const stop = async s => { s.child.kill('SIGKILL'); await sleep(800); };
const appJobs = async kind => (await timing()).filter(f => f[1] === kind && f[3] === 'job-start').length;
const checkEnds = async () => (await timing()).filter(f => f[1] === 'app check' && f[3] === 'job-end').length;
const datesLines = async () => (await stage('app-dates-check')).map(f => f[5] || '');
const runCheck = async (extraEnv = {}) => {
  await setStaleReport(); await fs.writeFile(calls, '');
  const before = await checkEnds();
  const s = startServer(extraEnv); servers.push(s); await s.ready;
  await until(async () => (await checkEnds()) > before, 'the app check ends', 180000);
  await sleep(1500);
  return s;
};
try {
  const first = startServer(); servers.push(first); await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => /Stage: (?:verification pending|ready)\./.test(await first.tool('databrain_setup_status')), 'setup reaches ready', 900000);
  await settle();
  await stop(first);

  // A) two NEW items the app will not hand over (a fetch by id gives nothing for them). Old code: 'updated' every check, a blind full refresh, a fetch every day.
  let rows = JSON.parse(await fs.readFile(fixture, 'utf8'));
  rows.push(row('y-1', 'Unreadable one', 'never given', rows[0].d), row('y-2', 'Unreadable two', 'never given', rows[0].d)); await write(rows);
  await fs.writeFile(path.join(temp, 'unfetch.json'), JSON.stringify(['y-1', 'y-2']));
  const refreshesBeforeA = await appJobs('refresh');
  let s = await runCheck();
  assert.deepEqual(await log(), ['dates', 'fetch y-1,y-2'], 'check 1 asks the dates, then fetches the two new items');
  const lineA = (await datesLines()).at(-1);
  assert(/Datebook: unchanged/.test(lineA) && /content identical/.test(lineA), `nothing was handed over, so nothing changed: ${lineA}`);
  assert.equal(await appJobs('refresh'), refreshesBeforeA, 'and no refresh was started');
  await stop(s);
  s = await runCheck();
  assert.deepEqual(await log(), ['dates'], 'check 2 (the same reminders again) asks the dates and fetches nothing: the same items compare unchanged');
  assert(/Datebook: unchanged/.test((await datesLines()).at(-1)), 'and says unchanged');
  assert.equal(await appJobs('refresh'), refreshesBeforeA, 'still no refresh');
  await stop(s);
  console.log('  items the app will not hand over: unchanged, no refresh, not asked for again');

  // B) the same instants written another way (".000Z"): the same dates, not a change
  rows = JSON.parse(await fs.readFile(fixture, 'utf8')).map(r => ({ ...r, d: typeof r.d === 'string' ? r.d.replace(/Z$/, '.000Z') : r.d })); await write(rows);
  s = await runCheck();
  assert.deepEqual(await log(), ['dates'], 'dates written another way for the same instants: no fetch at all');
  assert(/Datebook: unchanged/.test((await datesLines()).at(-1)), 'unchanged');
  assert.equal(await appJobs('refresh'), refreshesBeforeA, 'no refresh');
  await stop(s);
  console.log('  the same dates in another notation: unchanged, nothing fetched');

  // C) one page really edited: fast refresh of that page, no full walk
  rows = JSON.parse(await fs.readFile(fixture, 'utf8')); rows[3] = { ...rows[3], b: 'part13edited the page really changed', d: '2026-07-07T10:00:00.000Z' }; await write(rows);
  const stagesBeforeC = (await timing()).length;
  s = await runCheck();
  await until(async () => (await timing()).slice(stagesBeforeC).some(f => f[1] === 'refresh' && f[3] === 'job-end'), 'the refresh ends', 180000);
  const afterC = (await timing()).slice(stagesBeforeC);
  const plan = afterC.find(f => f[3] === 'refresh-plan');
  assert(plan && /^fast|fast refresh/i.test(plan[5]) , `one edited page: the refresh takes the fast path: ${plan && plan[5]}`);
  assert(!afterC.some(f => f[3] === 'ingest-root'), 'and walks no roots');
  assert(/changed=1/.test(plan[5]), `and it names the one changed file: ${plan[5]}`);
  await settle(); await stop(s);
  console.log('  one edited page: fast refresh, no root walk');

  // D) the app never answers: the check ends with a logged reason (limit shortened to 2 s), and the next check runs
  await fs.writeFile(delayFile, '30000');
  const t0 = Date.now();
  s = await runCheck({ DATABRAIN_TEST_APP_QUESTION_MS: '2000' });
  const lineD = (await datesLines()).at(-1);
  assert(/Datebook: failed/.test(lineD) && /did not answer within 2 s/.test(lineD), `a question with no answer ends with a reason: ${lineD}`);
  assert(Date.now() - t0 < 60000, `and does not wait for ever: ${Date.now() - t0} ms`);
  const endD = (await timing()).filter(f => f[1] === 'app check' && f[3] === 'job-end').at(-1);
  assert(/complete/.test(endD[5] || ''), `the job ends cleanly: ${endD[5]}`);
  const diag = await s.tool('databrain_diagnostics');
  assert(/Datebook could not be read just now/.test(diag) && /did not answer/.test(diag), `diagnostics say so in plain words:\n${diag.slice(0, 600)}`);
  await stop(s);
  await fs.writeFile(delayFile, '0');
  s = await runCheck();
  assert((await datesLines()).at(-1).startsWith('Datebook: unchanged'), 'the next check runs and answers');
  await stop(s);
  console.log('  an app that never answers: ended with a logged reason, the next check runs');
  console.log('PASS: unreadable items, re-written dates and the same reminders read twice compare unchanged and start nothing; one edited page refreshes fast; a question with no answer ends with a logged reason.');
} finally {
  for (const server of servers) server.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
