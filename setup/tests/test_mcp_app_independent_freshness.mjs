// One slow or unchanged app never holds back another app's change (2026-10-12, real Mac: Notes reported an edit after 1.3 s, Reminders took
// 14.9 s to say "unchanged", the call gave up at its 15 s limit and the answer used the old index). Stand-in apps answer on a scaled clock:
//   A) Datebook has an edit, Pagelog needs 9 s to answer "unchanged": the question's answer has the Datebook edit and ends long before 9 s;
//   B) the slow app's OWN edit (it finds a change after 9 s) is indexed by itself later, with no new question needed;
//   C) an edit in a plain folder file is not held back by the slow app either.
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

const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nindepsteadymarker an ordinary note.\n');
const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
const APPS = ['Datebook', 'Pagelog'];
for (const name of APPS) {
  const bundle = path.join(appsDir, `${name}.app`, 'Contents');
  await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.${name.toLowerCase()}</string><key>CFBundleName</key><string>${name}</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>`);
  await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);
}
const rowsOf = name => path.join(temp, `rows-${name}.json`);
const delayOf = name => path.join(temp, `dates-delay-${name}.txt`);
const rowFor = (i, t, b, d) => ({ i, t, b, d, c: 'Home' });
const writeRows = (name, rows) => fs.writeFile(rowsOf(name), JSON.stringify(rows));
for (const name of APPS) await writeRows(name, [rowFor(`${name}-1`, 'First page', `indep${name.toLowerCase()}first stays`, '2026-01-01T10:00:00Z'), rowFor(`${name}-2`, 'Second page', `indep${name.toLowerCase()}second before`, '2026-01-02T10:00:00Z')]);
for (const name of APPS) await fs.writeFile(delayOf(name), '0');
const stub = path.join(temp, 'interpreter-stub.mjs');
await fs.writeFile(stub, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const script = process.argv[5];
const name = path.basename(/Application\\("([^"]+)"\\)/.exec(script)[1], '.app');
const rows = JSON.parse(fs.readFileSync(path.join(process.env.ROWS_DIR, 'rows-' + name + '.json'), 'utf8'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
if (script.includes('// dates only')) { await wait(Number(fs.readFileSync(path.join(process.env.ROWS_DIR, 'dates-delay-' + name + '.txt'), 'utf8')) || 0); console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) })); }
else if (script.includes('// fetch by id')) { const ids = JSON.parse(script.match(/for \\(const id of (\\[.*?\\])\\)/)[1]); console.log(JSON.stringify(rows.filter(r => ids.includes(r.i)))); }
else if (script.includes('// full read')) console.log(JSON.stringify(rows));
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });

const dataHome = path.join(home, 'DataBrain');
let n = 0;
function startServer() {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], { env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_RECENT_MS: '0', DATABRAIN_TEST_APP_OSASCRIPT: stub, ROWS_DIR: temp, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_FRESH_CAP_MS: '12000', DATABRAIN_TEST_APP_GRACE_MS: '2000', DATABRAIN_TEST_STATUS_WAIT_MS: '1000' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const base = name => [rowFor(`${name}-1`, 'First page', `indep${name.toLowerCase()}first stays`, '2026-01-01T10:00:00Z'), rowFor(`${name}-2`, 'Second page', `indep${name.toLowerCase()}second before`, '2026-01-02T10:00:00Z')];

  // A) Datebook edits; Pagelog is slow (9 s) and has nothing new
  await fs.writeFile(delayOf('Pagelog'), '9000');
  await writeRows('Datebook', [...base('Datebook'), rowFor('Datebook-3', 'Third page', 'indepdatebookthird indepfastword arrives', '2026-03-03T10:00:00Z')]);
  await sleep(400);
  const mark = (await timing()).length;
  const fast = await timed(() => server.tool('databrain_search', { query: 'indepfastword' }));
  assert(/Datebook > Home > Third page/.test(fast.value), `the answer has the Datebook edit although Pagelog is slow:\n${fast.value.slice(0, 400)}`);
  assert(fast.ms < 6500, `and ends long before the slow app answers (9 s): ${fast.ms} ms`);
  const lines = (await timing()).slice(mark).filter(f => f[3] === 'app-dates-check');
  assert(lines.some(f => /^Datebook: updated/.test(f[5] ?? '')), `the log shows the Datebook answer: ${JSON.stringify(lines)}`);
  await until(async () => (await timing()).slice(mark).some(f => f[3] === 'app-dates-check' && /^Pagelog: /.test(f[5] ?? '')), 'the slow app answers in the background', 30000);
  const pagelogLine = (await timing()).slice(mark).find(f => f[3] === 'app-dates-check' && /^Pagelog: unchanged/.test(f[5] ?? ''));
  assert(pagelogLine && /question \d+ ms, app already running/.test(pagelogLine[5]), `the log splits the app's time (question vs starting the app): ${JSON.stringify(pagelogLine)}`);
  await settle();

  // B) the slow app finds its own change after 9 s: indexed by itself, later, with no help from the call that started the check
  await fs.writeFile(delayOf('Pagelog'), '4000');
  await writeRows('Pagelog', [...base('Pagelog'), rowFor('Pagelog-3', 'Third page', 'indeppagelogthird indeplateword arrives', '2026-03-04T10:00:00Z')]);
  await sleep(400);
  const early = await timed(() => server.tool('databrain_search', { query: 'indeplateword' }));
  assert(!/Pagelog > Home > Third page/.test(early.value), 'the slow app is not waited for beyond its grace (not in this answer yet)');
  assert(early.ms < 6500, `the call ends inside the grace, not at the slow app's 4 s plus work: ${early.ms} ms`);
  await until(async () => /Pagelog > Home > Third page/.test(await server.tool('databrain_search', { query: 'indeplateword' })), 'the late change is indexed by itself', 60000);

  // C) a folder file edited while a slow app is being asked is not held back by it
  await settle();
  await fs.writeFile(delayOf('Pagelog'), '9000');
  await writeRows('Pagelog', [...base('Pagelog'), rowFor('Pagelog-3', 'Third page', 'indeppagelogthird indeplateword arrives', '2026-03-04T10:00:00Z'), rowFor('Pagelog-4', 'Fourth page', 'indeppagelogfourth moves', '2026-03-05T10:00:00Z')]);
  await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nindepsteadymarker indepfolderword an edited ordinary note.\n');
  await sleep(400);
  const folder = await timed(() => server.tool('databrain_search', { query: 'indepfolderword' }));
  assert(/plain\.md/.test(folder.value), `the folder edit is in the answer:\n${folder.value.slice(0, 400)}`);
  assert(folder.ms < 7500, `and a slow app (9 s) did not hold it back: ${folder.ms} ms`);

  console.log('PASS: a slow app does not hold back another app\'s edit (answer fast), its own late edit is indexed by itself, a folder edit is not held back, and the log splits each app\'s time into question and app start.');
} finally {
  server?.child.kill('SIGKILL');
  await sleep(1200);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
