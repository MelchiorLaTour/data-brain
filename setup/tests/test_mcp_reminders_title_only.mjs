// Part 16 (0.2.1), item C: a reminder is often only a title. Before, an item with an empty note was skipped, so a Mac with 308 reminders indexed 3 of
// them ("Look at my emails" was missing; a rename never showed, and the renamed item was fetched again at every check). Now a title-only item is
// kept with its title as its text; two lists with the same name never overwrite each other; a record written by the older version (title-only items
// remembered as "never fetched") is read in full once and then compared by dates again. Stand-in app and invented data only.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-remtitle-')));
const home = path.join(temp, 'home'); await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nremtitleplainmarker an ordinary note.\n');
// the dictionary of Reminders: class "reminder" with name / body / id / modification date / container
const sdef = '<dictionary><suite name="S"><class name="reminder" code="remd" plural="reminders"><property name="name" code="pnam" type="text"/><property name="body" code="body" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="list"/><property name="completed" code="comp" type="boolean"/></class></suite></dictionary>';
const bundle = path.join(appsDir, 'Reminders.app', 'Contents');
await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
await fs.writeFile(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Reminders</string><key>CFBundleIdentifier</key><string>com.example.remindersstandin</string><key>CFBundleExecutable</key><string>Reminders</string><key>OSAScriptingDefinition</key><string>R.sdef</string></dict></plist>');
await fs.writeFile(path.join(bundle, 'Resources', 'R.sdef'), sdef);

const fixture = path.join(temp, 'fixture.json'); const calls = path.join(temp, 'calls.log');
const row = (i, t, b, d, c) => ({ i, t, b, d, c, x: false, p: false });
const D = n => `2026-01-0${n}T10:00:00Z`;
const write = rows => fs.writeFile(fixture, JSON.stringify(rows));
await write([
  row('r-1', 'Look at my emails', null, D(1), 'Reminders'),             // title only, open; the app gives a missing value (null), not '' (part 19: real Mac, 305 of 308 dropped)
  row('r-2', 'Book flights remtitleflights', undefined, D(1), 'Family'),   // title only, another list; the field is absent
  row('r-3', 'Pay rent', 'transfer on friday remtitlenote', D(1), 'Reminders'),   // has a note
  row('r-4', 'Call dentist', '', D(1), 'Reminders'),                     // same title and same list name as r-5 ...
  row('r-5', 'Call dentist', '', D(1), 'Reminders'),                     // ... two lists called "Reminders" (two accounts)
  row('r-6', '', '', D(1), 'Reminders'),                                 // nothing at all: skipped
]);
const stub = path.join(temp, 'interpreter-stub.mjs');
await fs.writeFile(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const script = process.argv[5];
const rows = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
const log = line => fs.appendFileSync(process.env.CALL_LOG, line + '\\n');
if (script.includes('// dates only')) { log('dates'); console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) })); }
else if (script.includes('// fetch by id')) { const ids = JSON.parse(script.match(/for \\(const id of (\\[.*?\\])\\)/)[1]); log('fetch ' + ids.join(',')); console.log(JSON.stringify(rows.filter(r => ids.includes(r.i)))); }
else if (script.includes('// full read')) { log('full'); console.log(JSON.stringify(rows)); }
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });

const dataHome = path.join(home, 'DataBrain');
const mirror = path.join(dataHome, 'app-content', 'Reminders');
const manifestDir = path.join(dataHome, '.databrain', 'app-items');
const baseEnv = { ...process.env, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300', HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE: fixture, CALL_LOG: calls };
let n = 0;
function startServer() {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], { env: { ...baseEnv, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, tool, ready };
}
const timing = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => l.split('\t'));
const callLog = async () => (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
const files = async () => (await fs.readdir(mirror, { recursive: true }).catch(() => [])).filter(name => name.endsWith('.md')).sort();
const checkEnds = async () => (await timing()).filter(f => f[1] === 'app check' && f[3] === 'job-end').length;
const settle = async () => until(async () => { const rows = await timing(); return ['index housekeeping', 'refresh', 'app check'].every(kind => rows.filter(f => f[1] === kind && f[3] === 'job-start').length === rows.filter(f => f[1] === kind && f[3] === 'job-end').length); }, 'jobs settle', 300000);
const setStaleReport = async () => { const old = new Date(Date.now() - 3600000); await fs.utimes(path.join(dataHome, '.databrain', 'app-report.json'), old, old); };
const stop = async s => { s.child.kill('SIGKILL'); await sleep(800); };
const servers = [];
const runCheck = async () => {
  await setStaleReport(); await fs.writeFile(calls, '');
  const before = await checkEnds();
  const s = startServer(); servers.push(s); await s.ready;
  await until(async () => (await checkEnds()) > before, 'the app check ends', 180000);
  await settle(); await sleep(1500);
  return s;
};
try {
  const first = startServer(); servers.push(first); await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => /Stage: (?:verification pending|ready)\./.test(await first.tool('databrain_setup_status')), 'setup reaches ready', 900000);
  await settle();

  // 1) every reminder with a title is kept: the title-only ones, the one with a note, and both "Call dentist" of the two lists named "Reminders"
  let names = await files();
  assert.equal(names.length, 5, `5 reminders are kept (the empty one is skipped): ${names.join(' | ')}`);
  assert(names.some(name => name.startsWith('Reminders/Look at my emails')), `the title-only reminder "Look at my emails" is kept: ${names.join(' | ')}`);
  assert.equal(names.filter(name => name.includes('Call dentist')).length, 2, 'two lists with the same name and two reminders with the same title do not overwrite each other');
  const remSearch = await first.tool('databrain_search', { query: 'emails' });
  assert(/Look at my emails/.test(remSearch), 'the title-only reminder is searchable');
  // Part 22: ChatGPT is told, as a fact, that Notes and Reminders results come from DataBrain's saved copy (it used to try to open the app to verify); the Claude host's text is unchanged
  const copyFact = /Notes and Reminders results come from DataBrain's own saved copy of them, which DataBrain keeps current by itself\./.test(remSearch);
  assert.equal(copyFact, process.env.DATABRAIN_TEST_CLIENT === 'chatgpt', `the saved-copy fact is in ChatGPT answers about Reminders only:\n${remSearch.slice(0, 500)}`);
  assert(!/open (?:the )?(?:Reminders|Notes)|computer (?:use|access)/i.test(remSearch), 'no text invites opening the app');
  assert(/remtitleflights/.test(await first.tool('databrain_search', { query: 'remtitleflights' })), 'a title-only reminder in another list is searchable');
  assert(/remtitlenote/.test(await first.tool('databrain_search', { query: 'remtitlenote' })), 'a reminder with a note is still searchable');
  await stop(first);

  // 2) a record written by the older version: title-only items remembered as never fetched, no file. One full read brings them back, once.
  const manifestFile = (await fs.readdir(manifestDir)).find(name => /reminders/i.test(name));
  assert(manifestFile, 'the app record exists');
  const record = JSON.parse(await fs.readFile(path.join(manifestDir, manifestFile), 'utf8'));
  assert.equal(record.rules, 3, 'the record carries the current rules number');
  delete record.rules;
  for (const id of ['r-1', 'r-2', 'r-4', 'r-5']) { const file = record.items[id].file; if (file) await fs.unlink(file).catch(() => {}); record.items[id].file = null; }
  await fs.writeFile(path.join(manifestDir, manifestFile), JSON.stringify(record));
  assert.equal((await files()).length, 1, 'the old state: only the reminder with a note has a file');
  const second = await runCheck();
  assert((await callLog()).includes('full'), `the old record is read in full once: ${(await callLog()).join(',')}`);
  assert.equal((await files()).length, 5, 'after the full read the title-only reminders are back');
  assert(/Look at my emails/.test(await second.tool('databrain_search', { query: 'emails' })), 'and searchable again');
  await stop(second);

  // 2b) part 20: a record written by build 7d23e367 (rules 2, written while a missing-value note still dropped the reminder) is read in full ONCE by itself, then never again
  const record2 = JSON.parse(await fs.readFile(path.join(manifestDir, manifestFile), 'utf8'));
  record2.rules = 2; await fs.writeFile(path.join(manifestDir, manifestFile), JSON.stringify(record2));
  const rules2 = await runCheck();
  assert((await callLog()).includes('full'), `a rules-2 record is read in full once: ${(await callLog()).join(',')}`);
  assert.equal(JSON.parse(await fs.readFile(path.join(manifestDir, manifestFile), 'utf8')).rules, 3, 'and it is rewritten with rules 3');
  await stop(rules2);
  const rules3 = await runCheck();
  assert(!(await callLog()).includes('full'), `the next check does not read in full again: ${(await callLog()).join(',')}`);
  await stop(rules3);

  // 3) a rename of a title-only reminder: picked up, the old title gone, and not fetched again at the next check
  let rows = JSON.parse(await fs.readFile(fixture, 'utf8'));
  rows = rows.map(r => r.i === 'r-1' ? { ...r, t: 'Look at my emails remtitlepigeon', d: D(2) } : r); await write(rows);
  const third = await runCheck();
  assert((await callLog()).some(line => line === 'fetch r-1'), `the renamed reminder is fetched: ${(await callLog()).join(',')}`);
  assert(/remtitlepigeon/.test(await third.tool('databrain_search', { query: 'remtitlepigeon' })), 'the new title is searchable');
  names = await files();
  assert(!names.some(name => /Look at my emails \[/.test(name)) && names.some(name => name.includes('remtitlepigeon')), `the old file name is gone: ${names.join(' | ')}`);
  await stop(third);
  const fourth = await runCheck();
  assert(!(await callLog()).some(line => line.startsWith('fetch')), `nothing is fetched again at the next check: ${(await callLog()).join(',')}`);
  console.log('PASS: title-only reminders are kept and searchable (two lists with the same name and two equal titles do not collide); an older record is read in full once; a renamed title-only reminder is picked up and not fetched again.');
} finally {
  for (const s of servers) s.child.kill('SIGKILL');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true });
}
