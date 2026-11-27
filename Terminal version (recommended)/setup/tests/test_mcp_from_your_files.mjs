// Answers come from the user's files, visibly: every hit starts with "From your files:" and its source (path, or "<App> > <folder> > <title>"),
// a read starts the same way, and an empty search says "DataBrain found nothing on this" and tells Claude not to fill in from chat memory.
// (That last part is an instruction to Claude; code can only make the words appear in the result.)
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-fromfiles-')));
const home = path.join(temp, 'home');
await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nfromfilessteadymarker an ordinary note.\n');
// a dictionary with its own vocabulary: class "page" (plural "pages"), properties title / text / id / modification date / container / locked
const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
const bundle = path.join(appsDir, 'Datebook.app', 'Contents');
await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
await fs.writeFile(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.datebook</string><key>CFBundleName</key><string>Datebook</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>');
await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);

const fixture = path.join(temp, 'fixture.json'); const calls = path.join(temp, 'calls.log');
const row = (i, t, b, d, extra = {}) => ({ i, t, b, d, c: 'Home', ...extra });
const write = rows => fs.writeFile(fixture, JSON.stringify(rows));
await write([row('x-1', 'First page', 'fromfilesfirstmarker stays untouched', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'fromfilessecondmarker before the edit', '2026-01-02T10:00:00Z'), row('x-3', 'Third page', 'fromfilesthirdmarker will be deleted', '2026-01-03T10:00:00Z')]);
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




let n = 0;
function startServer(roots, extraEnv = {}) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE: fixture, CALL_LOG: calls, DATABRAIN_FRESHNESS_CHECK_MS: '100', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, tool, ask, ready };
}
async function setupReady(server) {
  await server.ready; await server.tool('databrain_setup_start');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'setup reaches ready');
}

const servers = [];
try {
  await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain note\nfromfilesplainmarker an ordinary note in a folder.\n');
  await write([row('x-1', 'Garden plan', 'fromfilesappmarker tomatoes in May', '2026-01-01T10:00:00Z')]);
  const s = startServer([realApps, realDocs]); servers.push(s); await setupReady(s);
  const fileHit = await s.tool('databrain_search', { query: 'fromfilesplainmarker' });
  const lines = fileHit.split('\n');
  const k = lines.findIndex(l => /^\s*\d+\s+-?[0-9.]+\s+/.test(l));
  assert(k > 0 && lines[k - 1] === `From your files: ${lines[k].replace(/^\s*\d+\s+-?[0-9.]+\s+/, '')}`, `a file hit starts with "From your files:" and its path:\n${fileHit}`);
  const appHit = await s.tool('databrain_search', { query: 'fromfilesappmarker' });
  assert(/^From your files: Datebook > Home > Garden plan$/m.test(appHit), `an app hit starts with "From your files: <App> > <folder> > <title>":\n${appHit}`);
  const appLines = appHit.split('\n'); const ak = appLines.findIndex(l => /^\s*\d+\s+-?[0-9.]+\s+/.test(l));
  assert(appLines[ak - 1] === 'From your files: Datebook > Home > Garden plan', 'the source line sits directly above the hit');
  const appPath = appLines[ak].replace(/^\s*\d+\s+-?[0-9.]+\s+/, '');
  const read = await s.tool('databrain_read', { path: appPath });
  assert(read.startsWith('From your files: Datebook > Home > Garden plan\nEvidence from: '), `a read of an app item starts with its source:\n${read.slice(0, 300)}`);
  const filePath = lines[k].replace(/^\s*\d+\s+-?[0-9.]+\s+/, '');
  assert((await s.tool('databrain_read', { path: filePath })).startsWith(`From your files: ${filePath}\nEvidence from: `), 'a read of a file starts with its path');
  const nothing = await s.tool('databrain_search', { query: 'zzzqqqnotanywhere' });
  assert(/DataBrain found nothing on this/.test(nothing), `empty search:\n${nothing}`);
  const dry = await s.tool('databrain_abstain_check', { queries: ['zzzqqqnotanywhere', 'yyyxxxnothingtoo'] });
  assert(/DRY[^\n]*DataBrain found nothing on this/.test(dry), `abstain with nothing found, in the route line itself:\n${dry}`);
  const listed = (await s.ask('tools/list', {})).result.tools;
  for (const name of ['databrain_search', 'databrain_abstain_check', 'databrain_read']) {
    const d = listed.find(t => t.name === name).description;
    assert(/From your files/.test(d) && (name === 'databrain_read' || (/found nothing/.test(d) && /do not guess/.test(d) && (name === 'databrain_search' ? /for ANY question about the user.*call databrain_search FIRST/i.test(d) : /Claude's memory does not have the answer/.test(d)))), `${name} carries its retrieval rule, source label, and no-guess instruction`);
  }
  console.log('PASS: every hit starts with "From your files:" and its source; a read starts the same way; an empty search says "DataBrain found nothing on this"; the tool descriptions say when to use DataBrain and not to guess.');
} finally {
  for (const x of servers) x.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
