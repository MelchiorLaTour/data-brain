// Part 12 (0.2.1): every question said "DataBrain is still indexing recent changes" although nothing was being indexed (a routine date check of Notes
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-falsewarn-')));
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
if (script.includes('// dates only')) { need('app.pages', 'c.id()', 'c.modificationDate()'); if (/c\\.text\\(\\)|c\\.title\\(\\)/.test(script)) { console.error('a dates-only question must not ask for text or titles'); process.exit(3); } log('dates'); if (fs.existsSync(process.env.FAIL_FILE)) { await nap(500); console.error('simulated: Reminders got an error: the app is not responding (-609)'); process.exit(1); } await nap(Number(fs.existsSync(process.env.DELAY_FILE) ? fs.readFileSync(process.env.DELAY_FILE, 'utf8') : 0) || 0); console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) })); }
else if (script.includes('// fetch by id')) { need('c.byId(id)', 'it.title()', 'it.text()', 'it.modificationDate()', 'it.locked()'); const ids = JSON.parse(script.match(/for \\(const id of (\\[.*?\\])\\)/)[1]); log('fetch ' + ids.join(',')); await nap(Number(fs.existsSync(process.env.FETCH_DELAY_FILE) ? fs.readFileSync(process.env.FETCH_DELAY_FILE, 'utf8') : 0) || 0); console.log(JSON.stringify(rows.filter(r => ids.includes(r.i)))); }
else if (script.includes('// full read')) { need('app.pages', 'c.title()', 'c.text()', 'c.id()'); log('full'); await nap(Number(process.env.FULL_DELAY_MS || 0)); console.log(JSON.stringify(rows)); }
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });

const DOCS = process.env.DATABRAIN_TEST_CLIENT === 'chatgpt' ? 60 : 200;
for (let k = 0; k < DOCS; k++) await fs.writeFile(path.join(realDocs, `note-${k}.md`), `# Note ${k}\nfalsewarnmarker${k} an invented note number ${k} about nothing real.\n`);

const delayFile = path.join(temp, 'dates-delay.txt'); const failFile = path.join(temp, 'fail-now');
await fs.writeFile(delayFile, '0');
const dataHome = path.join(home, 'DataBrain');
const log = async () => (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const baseEnv = { ...process.env, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300', HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE: fixture, CALL_LOG: calls, DELAY_FILE: delayFile, FETCH_DELAY_FILE: path.join(temp, 'fetch-delay.txt'), FAIL_FILE: failFile, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_APP_RECENT_MS: '0', DATABRAIN_TEST_LOCK_POLL_MS: '200' };
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
try {
  const first = startServer(); servers.push(first); await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => /Stage: (?:verification pending|ready)\./.test(await first.tool('databrain_setup_status')), 'setup reaches ready', 900000);
  await settle();
  await stop(first);

  // 1) fix 1 + 2: Notes and Reminders are UNCHANGED but the date check is slow (5 s): the first question of the minute carries no "being added" sentence and answers in under 3 s
  await fs.writeFile(delayFile, '5000'); await fs.writeFile(calls, ''); await setStaleReport();
  const s1 = startServer(); servers.push(s1); await s1.ready;
  await until(async () => (await stage('job-end')).some(f => f[1] === 'app check'), 'the start-up app check ends', 120000);
  await sleep(1500);
  const q1 = await timed(() => s1.tool('databrain_search', { query: 'falsewarnmarker7' }));
  const waited = (await stage('on-use wait')).map(f => f[5]).join(' | ');
  assert(!BEING_ADDED.test(q1.value), `unchanged apps, slow date check: no "being added" sentence.\n${q1.value.slice(0, 300)}\non-use waits: ${waited}`);
  assert(/falsewarnmarker7/.test(q1.value), 'and the answer is there');
  assert(q1.ms < 3000, `the first question answers in under 3 s while the date check runs alongside: ${q1.ms} ms. Stages:\n${(await timing()).slice(-12).map(f => f.slice(1).join(' ')).join('\n')}`);
  console.log(`  slow unchanged date check: first question ${q1.ms} ms, no warning`);
  await until(async () => (await log()).filter(l => l === 'dates').length >= 2, 'the date check ran', 60000);
  await sleep(6000);
  const q1b = await timed(() => s1.tool('databrain_search', { query: 'falsewarnmarker8' }));
  assert(!BEING_ADDED.test(q1b.value), 'and no warning afterwards either');
  await stop(s1);

  // 1c) part 12b, the commonest real case: a new chat starts the start-up app check, Notes and Reminders are UNCHANGED, and the user asks a question while it runs
  await fs.writeFile(delayFile, '8000'); await setStaleReport(); await fs.writeFile(calls, '');
  const startsC = (await stage('job-start')).filter(f => f[1] === 'app check').length;
  const sC = startServer(); servers.push(sC); await sC.ready;
  await until(async () => (await stage('job-start')).filter(f => f[1] === 'app check').length > startsC, 'the start-up app check is running', 60000);
  await until(async () => (await log()).includes('dates'), 'and is in the middle of its question', 60000);
  const qC = await timed(() => sC.tool('databrain_search', { query: 'falsewarnmarker11' }));
  assert(!BEING_ADDED.test(qC.value), `a question during an unchanged start-up app check carries no "being added" sentence:\n${qC.value.slice(0, 300)}`);
  assert(qC.ms < 3000, `and answers at once: ${qC.ms} ms`);
  await until(async () => (await stage('job-end')).filter(f => f[1] === 'app check').length >= startsC + 1, 'that app check ends', 120000);
  await settle(); await stop(sC);
  console.log(`  question during an unchanged start-up app check: ${qC.ms} ms, no warning`);

  // 1d) the reverse: the start-up app check finds a change. While Notes still answers the date question nothing is known (no sentence);
  //     the moment the dates show an edited page, a question during the (slow) fetch of it says it is being added
  let rowsD = JSON.parse(await fs.readFile(fixture, 'utf8')); rowsD[9] = { ...rowsD[9], b: 'falsewarnfetch the page edited before the chat', d: '2026-06-06T10:00:00Z' }; await write(rowsD);
  await fs.writeFile(delayFile, '4000'); await fs.writeFile(path.join(temp, 'fetch-delay.txt'), '9000'); await setStaleReport(); await fs.writeFile(calls, '');
  const startsD = (await stage('job-start')).filter(f => f[1] === 'app check').length;
  const sD = startServer({ DATABRAIN_TEST_UPDATE_DELAY_MS: '1000' }); servers.push(sD); await sD.ready;
  await until(async () => (await stage('job-start')).filter(f => f[1] === 'app check').length > startsD, 'the app check is running', 60000);
  await until(async () => (await log()).includes('dates'), 'it asks for the dates', 60000);
  const beforeAnswer = await sD.tool('databrain_search', { query: 'falsewarnmarker12' });
  assert(!BEING_ADDED.test(beforeAnswer), `while the dates question is still open nothing is known: no sentence.\n${beforeAnswer.slice(0, 300)}`);
  await until(async () => (await log()).some(l => l.startsWith('fetch')), 'the dates showed an edited page and its fetch has begun', 60000);
  const duringFetch = await sD.tool('databrain_search', { query: 'falsewarnmarker13' });
  assert(BEING_ADDED.test(duringFetch.slice(0, 400)), `a question during the fetch of a found change says it is being added:\n${duringFetch.slice(0, 400)}`);
  await until(async () => (await stage('job-end')).filter(f => f[1] === 'app check').length >= startsD + 1, 'the app check ends', 180000);
  await settle(); await stop(sD);
  console.log('  start-up app check that finds a change: no sentence before the dates answer, sentence during the fetch');

  // 2) something really changed: a page is edited in the app, the date check answers within the question's wait, the update is slow: the answer says it is being added
  await fs.writeFile(delayFile, '0'); await settle();
  let rows = JSON.parse(await fs.readFile(fixture, 'utf8')); rows[5] = { ...rows[5], b: 'falsewarnedited the edited page', d: '2026-04-04T10:00:00Z' }; await write(rows);
  await fs.writeFile(calls, '');
  const endsBefore2 = (await stage('job-end')).filter(f => f[1] === 'app check').length;
  const s2 = startServer({ DATABRAIN_TEST_UPDATE_DELAY_MS: '8000' }); servers.push(s2); await s2.ready;
  await until(async () => (await stage('job-end')).filter(f => f[1] === 'app check').length > endsBefore2, 'the app check of this server ends', 120000);
  await sleep(1000);
  const q2 = await s2.tool('databrain_search', { query: 'falsewarnmarker9' });
  assert(BEING_ADDED.test(q2.slice(0, 400)), `a change was found, so the answer says it is being added:\n${q2.slice(0, 400)}`);
  console.log('  a real change: the answer says it is being added');
  await settle(); await stop(s2);

  // 3) fix 3: ONE page changed in the app: the refresh takes the fast path (no walk of the folders, extract on that item only)
  rows = JSON.parse(await fs.readFile(fixture, 'utf8')); rows[6] = { ...rows[6], b: 'falsewarnfast the second edited page', d: '2026-05-05T10:00:00Z' }; await write(rows);
  await setStaleReport(); await fs.writeFile(calls, '');
  const refreshesBefore = (await timing()).filter(f => f[1] === 'refresh' && f[3] === 'job-start').length;
  const markBefore = (await timing()).length;
  const s3 = startServer(); servers.push(s3); await s3.ready;
  await until(async () => (await timing()).filter(f => f[1] === 'refresh' && f[3] === 'job-end').length > refreshesBefore, 'the refresh after the app change ends', 240000);
  const during = (await timing()).slice(markBefore);
  const plan = during.filter(f => f[3] === 'fast-refresh').map(f => f[5]);
  assert(plan.length === 1 && /added=0 changed=1 deleted=0 untracked=0/.test(plan[0]), `one changed page = a fast refresh of exactly that page: ${JSON.stringify(plan)}\n${during.map(f => f.slice(1).join(' ')).join('\n')}`);
  const walked = during.filter(f => /ingest-root|prune|inventory/.test(f[3]) && f[1] === 'refresh');
  assert.equal(walked.length, 0, `no walk of the folders in that refresh: ${JSON.stringify(walked)}`);
  assert(during.some(f => f[3] === 'refresh-plan' && /fast/.test(f[5] || '')), `the log says which path was taken and why:\n${during.map(f => f.slice(1).join(' ')).join('\n')}`);
  console.log('  one changed page: fast refresh');
  await settle(); await stop(s3);

  // 4) fix 4: Reminders (here: the app) fails during an app check: the job ends with a logged reason, diagnostics says so in plain words, and the next app check runs
  await fs.writeFile(failFile, '1'); await setStaleReport(); await fs.writeFile(calls, '');
  const endsBefore = (await timing()).filter(f => f[1] === 'app check' && f[3] === 'job-end').length;
  const s4 = startServer(); servers.push(s4); await s4.ready;
  await until(async () => (await timing()).filter(f => f[1] === 'app check' && f[3] === 'job-end').length > endsBefore, 'the app check ends although the app failed', 120000);
  const failedLine = (await stage('app-dates-check')).filter(f => /failed/.test(f[5] || '')).pop();
  assert(failedLine && /Datebook: failed \(.*not responding/.test(failedLine[5]), `the failed read logs why: ${JSON.stringify(failedLine)}`);
  const diag = await s4.tool('databrain_diagnostics');
  assert(/Datebook could not be read just now/.test(diag), `diagnostics says it in plain words:\n${diag.slice(0, 1200)}`);
  await stop(s4);
  await fs.rm(failFile, { force: true }); await setStaleReport(); await fs.writeFile(calls, '');
  const s4b = startServer(); servers.push(s4b); await s4b.ready;
  await until(async () => (await log()).includes('dates'), 'the next app check asks the app again', 60000);
  await until(async () => (await timing()).filter(f => f[1] === 'app check' && f[3] === 'job-end').length > endsBefore + 1, 'and ends', 120000);
  await sleep(500);
  const diag2 = await s4b.tool('databrain_diagnostics');
  assert(!/could not be read just now/.test(diag2), 'once the app answers again diagnostics no longer says it');
  await stop(s4b);

  // 4b) a server that dies in the middle of an app check (killed, not closed): the next server closes its log line and its own check runs
  await fs.writeFile(delayFile, '20000'); await setStaleReport(); await fs.writeFile(calls, '');
  const s5 = startServer(); servers.push(s5); await s5.ready;
  await until(async () => (await log()).includes('dates'), 'the check is in the middle of its question', 60000);
  await stop(s5);
  await fs.writeFile(delayFile, '0'); await setStaleReport();
  const endsBefore5 = (await timing()).filter(f => f[1] === 'app check' && f[3] === 'job-end').length;
  const s6 = startServer(); servers.push(s6); await s6.ready;
  await until(async () => (await timing()).filter(f => f[1] === 'app check' && f[3] === 'job-end' && /complete/.test(f[5] || '')).length > endsBefore5, 'the next app check runs to its end', 120000);
  const abandoned = (await timing()).filter(f => f[3] === 'job-end' && /abandoned/.test(f[5] || ''));
  assert(abandoned.length === 1 && abandoned[0][1] === 'app check', `the log closes the dead server's job once: ${JSON.stringify(abandoned)}`);
  await stop(s6);
  // closed by the app (TERM) while the job runs: the job says so itself
  await fs.writeFile(delayFile, '20000'); await setStaleReport(); await fs.writeFile(calls, '');
  const s7 = startServer(); servers.push(s7); await s7.ready;
  await until(async () => (await log()).includes('dates'), 'the check is in the middle of its question again', 60000);
  s7.child.kill('SIGTERM');
  await until(async () => (await timing()).some(f => f[3] === 'job-end' && /interrupted/.test(f[5] || '')), 'the interrupted job is logged', 20000);
  console.log('  failed read, killed server, closed server: each ends with a logged reason and the next check runs');
  console.log('PASS: an unchanged but slow date check gives no "being added" sentence and a fast answer; a real change still says it; one changed page refreshes fast; a failed or killed app check ends with a logged reason and does not block the next one');
} finally {
  for (const s of servers) s.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
