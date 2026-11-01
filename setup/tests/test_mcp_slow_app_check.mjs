// A call must end well inside the 20 s cap (A12) even when the check of the user's apps is slow (2026-10-11: a status call took 21 s on a real
// Mac because the check of Notes and Reminders ran for the whole cap). Stand-in apps answer slowly here, on a scaled clock:
//   - a question (search) waits at most its limit and the apps are asked AT THE SAME TIME, so two slow apps cost the slowest one, not the sum;
//   - a status report waits at most its own short limit: it only reports, it does not need the new changes;
//   - a call that comes while the check is still running waits for that same check (up to its limit) instead of answering stale at once;
//   - the log says how long each app took and how long each call waited, so the next slow call can be traced;
//   - the real limits leave room: a question waits 15 s at most and a status 3 s at most, both under the 20 s cap.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-slowapp-')));
const home = path.join(temp, 'home'); await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

// real limits, read from the source: both under the 20 s cap with room for the rest of the call
const source = await fs.readFile(serverScript, 'utf8');
const questionLimit = Number(/DATABRAIN_TEST_FRESH_CAP_MS\) \|\| (\d+)/.exec(source)?.[1]);
const statusLimit = Number(/DATABRAIN_TEST_STATUS_WAIT_MS\) \|\| (\d+)/.exec(source)?.[1]);
assert(questionLimit > 0 && questionLimit <= 15000, `a question waits at most 15 s (found ${questionLimit})`);
assert(statusLimit > 0 && statusLimit <= 5000, `a status report waits at most 5 s (found ${statusLimit})`);

const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nslowsteadymarker an ordinary note.\n');
const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
const APPS = ['Datebook', 'Pagelog'];
for (const name of APPS) {
  const bundle = path.join(appsDir, `${name}.app`, 'Contents');
  await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.${name.toLowerCase()}</string><key>CFBundleName</key><string>${name}</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>`);
  await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);
}
const rowsOf = name => path.join(temp, `rows-${name}.json`);
const delayFile = path.join(temp, 'dates-delay-ms.txt');
const rowFor = (i, t, b, d) => ({ i, t, b, d, c: 'Home' });
const writeRows = (name, rows) => fs.writeFile(rowsOf(name), JSON.stringify(rows));
for (const name of APPS) await writeRows(name, [rowFor(`${name}-1`, 'First page', `slow${name.toLowerCase()}first stays`, '2026-01-01T10:00:00Z'), rowFor(`${name}-2`, 'Second page', `slow${name.toLowerCase()}second before`, '2026-01-02T10:00:00Z')]);
await fs.writeFile(delayFile, '0');
const stub = path.join(temp, 'interpreter-stub.mjs');
await fs.writeFile(stub, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const script = process.argv[5];
const name = path.basename(/Application\\("([^"]+)"\\)/.exec(script)[1], '.app');
const rows = JSON.parse(fs.readFileSync(path.join(process.env.ROWS_DIR, 'rows-' + name + '.json'), 'utf8'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
if (script.includes('// dates only')) { await wait(Number(fs.readFileSync(process.env.DELAY_FILE, 'utf8')) || 0); console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) })); }
else if (script.includes('// fetch by id')) { const ids = JSON.parse(script.match(/for \\(const id of (\\[.*?\\])\\)/)[1]); console.log(JSON.stringify(rows.filter(r => ids.includes(r.i)))); }
else if (script.includes('// full read')) console.log(JSON.stringify(rows));
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });

const dataHome = path.join(home, 'DataBrain');
let n = 0;
function startServer() {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], { env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_RECENT_MS: '0', DATABRAIN_TEST_APP_OSASCRIPT: stub, ROWS_DIR: temp, DELAY_FILE: delayFile, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_FRESH_CAP_MS: '6000', DATABRAIN_TEST_STATUS_WAIT_MS: '1000' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, tool, ready };
}
const timing = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => line.split('\t'));
const settle = async () => { await until(async () => { const rows = await timing(); const kinds = ['index housekeeping', 'refresh']; return kinds.every(kind => rows.filter(f => f[1] === kind && f[3] === 'job-start').length === rows.filter(f => f[1] === kind && f[3] === 'job-end').length); }, 'jobs idle', 120000); await sleep(500); };
const timed = async work => { const t0 = Date.now(); const value = await work(); return { value, ms: Date.now() - t0 }; };

let server;
try {
  server = startServer(); await server.ready; await server.tool('databrain_setup_start');
  await until(async () => /Stage: (?:verification pending|ready)\./.test(await server.tool('databrain_setup_status')), 'setup finishes', 120000);
  await settle();
  const indexText = () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
  assert((await indexText()).includes('Datebook') && (await indexText()).includes('Pagelog'), 'both apps are in the index');

  // A) two slow apps are asked at the same time: the wait is one app (2 s), not two (4 s), and the first answer already has both edits
  await fs.writeFile(delayFile, '2000');
  await writeRows('Datebook', [rowFor('Datebook-1', 'First page', 'slowdatebookfirst stays', '2026-01-01T10:00:00Z'), rowFor('Datebook-2', 'Second page', 'slowdatebooksecond slowbothword now', '2026-02-02T10:00:00Z')]);
  await writeRows('Pagelog', [rowFor('Pagelog-1', 'First page', 'slowpagelogfirst stays', '2026-01-01T10:00:00Z'), rowFor('Pagelog-2', 'Second page', 'slowpagelogsecond slowbothword now', '2026-02-02T10:00:00Z')]);
  await sleep(400);
  const mark = (await timing()).length;
  const fresh = await timed(() => server.tool('databrain_search', { query: 'slowbothword' }));
  assert(/Datebook > Home > Second page/.test(fresh.value) && /Pagelog > Home > Second page/.test(fresh.value), `the first answer has both edits (two slow apps asked together):\n${fresh.value.slice(0, 400)}`);
  assert(!/New changes are being added/.test(fresh.value), 'no "being added" sentence when the check finished in time');
  assert(fresh.ms < 5900, `a question with two slow apps ends inside its limit: ${fresh.ms} ms`);
  const lines = (await timing()).slice(mark).filter(f => f[3] === 'app-dates-check');
  assert(lines.length === 2 && lines.some(f => /^Datebook: updated/.test(f[5] ?? '')) && lines.some(f => /^Pagelog: updated/.test(f[5] ?? '')), `the log times each app: ${JSON.stringify(lines)}`);
  assert(lines.every(f => parseInt(f[4], 10) >= 1800 && parseInt(f[4], 10) < 3500), `each app took about its own 2 s, in parallel: ${lines.map(f => f[4])}`);
  assert(Math.abs(Date.parse(lines[0][0]) - Date.parse(lines[1][0])) < 800, `both apps answered at the same moment (asked together), not 2 s apart (one after the other): ${lines.map(f => f[0])}`);
  await settle();

  // B) a status report does not wait for a slow check (3 s here); C) a question that comes while it runs waits for that same check
  await fs.writeFile(delayFile, '3000');
  await writeRows('Datebook', [rowFor('Datebook-1', 'First page', 'slowdatebookfirst stays', '2026-01-01T10:00:00Z'), rowFor('Datebook-2', 'Second page', 'slowdatebooksecond slowbothword now', '2026-02-02T10:00:00Z'), rowFor('Datebook-3', 'Third page', 'slowdatebookthird slowlateword arrives', '2026-03-03T10:00:00Z')]);
  await sleep(400);
  const statusCall = await timed(() => server.tool('databrain_setup_status'));
  assert(statusCall.ms < 2500, `a status report does not wait for the slow check: ${statusCall.ms} ms`);
  assert(statusCall.value.startsWith('Freshness: New changes are being added'), `the status says in one fact that changes are being added:\n${statusCall.value.slice(0, 200)}`);
  await sleep(200);
  const waiting = await timed(() => server.tool('databrain_search', { query: 'slowlateword' }));
  assert(/Datebook > Home > Third page/.test(waiting.value) && !/New changes are being added/.test(waiting.value), `a question that comes while the check runs waits for it and answers fresh:\n${waiting.value.slice(0, 400)}`);
  assert(waiting.ms < 6900, `and still ends inside its own limit: ${waiting.ms} ms`);
  const waits = (await timing()).filter(f => f[3] === 'on-use wait').map(f => f[5]);
  assert(waits.some(note => /gave up after \d+ ms \(limit 1000 ms\)/.test(note)) && waits.some(note => /update finished after \d+ ms/.test(note)), `the log says how long each call waited: ${JSON.stringify(waits)}`);

  console.log('PASS: with slow apps a status report ends inside its short limit, a question ends inside its limit because the apps are asked together, a call that comes while the check runs waits for that same check, the log times each app and each wait, and the real limits (15 s and 3 s) sit under the 20 s cap.');
} finally {
  server?.child.kill('SIGKILL');
  await sleep(1200);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
