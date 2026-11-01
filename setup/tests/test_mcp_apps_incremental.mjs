// A scriptable app that has item ids and modification dates in its dictionary is checked on a call by asking for ONLY the ids and dates (no
// bodies), comparing with the last read, fetching bodies only for new or changed items and dropping deleted ones. Generic: every class and
// property name comes from the stub's scripting dictionary. Stub app and stub interpreter only; the app is never touched for real.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-incr-')));
const home = path.join(temp, 'home');
await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nincrsteadymarker an ordinary note.\n');
// a dictionary with its own vocabulary: class "page" (plural "pages"), properties title / text / id / modification date / container / locked
const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
const bundle = path.join(appsDir, 'Datebook.app', 'Contents');
await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
await fs.writeFile(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.datebook</string><key>CFBundleName</key><string>Datebook</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>');
await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);

const fixture = path.join(temp, 'fixture.json'); const calls = path.join(temp, 'calls.log');
const row = (i, t, b, d, extra = {}) => ({ i, t, b, d, c: 'Home', ...extra });
const write = rows => fs.writeFile(fixture, JSON.stringify(rows));
await write([row('x-1', 'First page', 'incrfirstmarker stays untouched', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'incrsecondmarker before the edit', '2026-01-02T10:00:00Z'), row('x-3', 'Third page', 'incrthirdmarker will be deleted', '2026-01-03T10:00:00Z')]);
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

const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], { env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE: fixture, CALL_LOG: calls, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_FRESH_CAP_MS: '240000' }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
let n = 0;
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const refreshEnds = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(l => /\trefresh\t[0-9a-f]+\tjob-end/.test(l)).length;
try {
  await ask('initialize', { protocolVersion: '2025-03-26' });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'setup reaches ready').catch(async error => { throw new Error(`${error.message}\n${(await tool('databrain_setup_status')).slice(0, 3000)}\ncalls: ${(await log()).join(' | ')}`); });
  await sleep(1500);
  assert.deepEqual((await log()).filter(l => l !== 'dates'), ['full'], 'the first read is one full read');
  const firstFile = await fileWith('incrfirstmarker'); const firstStat = await fs.stat(firstFile);
  assert(await fileWith('incrthirdmarker'), 'the third page is in the mirror');

  // 1) the app changes with no tool call: nothing is asked
  await write([row('x-1', 'First page', 'incrfirstmarker stays untouched', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'incrsecondmarker AFTER the edit', '2026-02-02T10:00:00Z'), row('x-4', 'Fourth page', 'incrfourthmarker brand new page', '2026-02-04T10:00:00Z'), row('x-5', 'Trash page', 'incrtrashmarker moved to deleted', '2026-02-05T10:00:00Z', { c: 'Recently Deleted' })]);
  const before = (await log()).length;
  await sleep(3000);
  assert.equal((await log()).length, before, 'no question was asked of the app without a tool call');

  // 2) the next search: dates only, then bodies only for the new or changed items; deleted items are dropped; the answer is already fresh
  const answer = await tool('databrain_search', { query: 'incrfourthmarker' });
  assert(/From your files: Datebook > Home > Fourth page/.test(answer), `the first answer has the new page:\n${answer}`);
  const asked = (await log()).slice(before);
  assert.deepEqual(asked, ['dates', 'fetch x-2,x-4,x-5'], `one dates-only question, then a fetch of ONLY the new or changed ids: ${JSON.stringify(asked)}`);
  assert(await fileWith('AFTER the edit') && !(await fileWith('before the edit')), 'the edited page was rewritten');
  assert(!(await fileWith('incrthirdmarker')), 'the deleted page was dropped from the mirror');
  assert(!(await fileWith('incrtrashmarker')), 'a page that sits in a deleted folder is skipped');
  const firstAfter = await fs.stat(await fileWith('incrfirstmarker'));
  assert(firstAfter.ino === firstStat.ino && firstAfter.mtimeMs === firstStat.mtimeMs, 'the unchanged page was not touched');
  assert(!/incrthirdmarker/.test(await tool('databrain_search', { query: 'incrthirdmarker' })) || /No approved-source matches|WEAK|no matches/i.test(await tool('databrain_search', { query: 'incrthirdmarker' })), 'the deleted page is gone from search');

  // 3) nothing changed: dates only, nothing fetched; the skipped page is not fetched again and again
  await sleep(300); // the server skips a check made within DATABRAIN_FRESHNESS_CHECK_MS (100) of the last one
  const mark = (await log()).length;
  await tool('databrain_search', { query: 'incrfirstmarker' });
  assert.deepEqual((await log()).slice(mark), ['dates'], 'nothing changed: only the dates-only question');

  // 4) an item becomes locked: its file goes away, and it is not fetched again afterwards
  const rows = JSON.parse(await fs.readFile(fixture, 'utf8'));
  await write(rows.map(r => r.i === 'x-1' ? { ...r, d: '2026-03-01T10:00:00Z', p: true } : r));
  await sleep(300); // the server skips a check made within DATABRAIN_FRESHNESS_CHECK_MS (100) of the last one
  const mark2 = (await log()).length;
  await tool('databrain_search', { query: 'incrfirstmarker' });
  assert.deepEqual((await log()).slice(mark2), ['dates', 'fetch x-1'], 'the changed page was fetched');
  assert(!(await fileWith('incrfirstmarker')), 'a page that became locked is removed from the mirror');
  await sleep(300); // the server skips a check made within DATABRAIN_FRESHNESS_CHECK_MS (100) of the last one
  const mark3 = (await log()).length;
  await tool('databrain_search', { query: 'incrsecondmarker' });
  assert.deepEqual((await log()).slice(mark3), ['dates'], 'the locked page is not fetched again');

  // 5) a lot changed at once: one full read instead of many fetches
  const many = JSON.parse(await fs.readFile(fixture, 'utf8'));
  for (let i = 0; i < 60; i++) many.push(row(`m-${i}`, `Bulk page ${i}`, `incrbulkmarker${i} text`, '2026-04-01T10:00:00Z'));
  await write(many);
  await sleep(300); // the server skips a check made within DATABRAIN_FRESHNESS_CHECK_MS (100) of the last one
  const mark4 = (await log()).length;
  const bulk = await tool('databrain_search', { query: 'incrbulkmarker7' });
  assert.deepEqual((await log()).slice(mark4), ['dates', 'full'], 'too many changes: a full read');
  assert(/From your files: Datebook > Home > Bulk page 7/.test(bulk), `the full read is in the same answer:\n${bulk}`);
  console.log('PASS: a scriptable app is checked with a dates-only question; only new or changed items are fetched, deleted and skipped ones are dropped, unchanged ones are untouched, a big change falls back to one full read; no app names, all from the dictionary.');
} finally {
  child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
