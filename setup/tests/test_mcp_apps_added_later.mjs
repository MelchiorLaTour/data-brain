// The first big import of an app happens by itself, right after the Applications folder is added, like folder indexing: nothing waits for a
// question. The saved stage never stays "ready" while the app rows are missing, and the status never says ready either. Stub app only.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-added-')));
const home = path.join(temp, 'home');
await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\naddedsteadymarker an ordinary note.\n');
// a dictionary with its own vocabulary: class "page" (plural "pages"), properties title / text / id / modification date / container / locked
const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
const bundle = path.join(appsDir, 'Datebook.app', 'Contents');
await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
await fs.writeFile(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.datebook</string><key>CFBundleName</key><string>Datebook</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>');
await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);

const fixture = path.join(temp, 'fixture.json'); const calls = path.join(temp, 'calls.log');
const row = (i, t, b, d, extra = {}) => ({ i, t, b, d, c: 'Home', ...extra });
const write = rows => fs.writeFile(fixture, JSON.stringify(rows));
await write([row('x-1', 'First page', 'addedfirstmarker stays untouched', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'addedsecondmarker before the edit', '2026-01-02T10:00:00Z'), row('x-3', 'Third page', 'addedthirdmarker will be deleted', '2026-01-03T10:00:00Z')]);
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



const baseEnv = { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE: fixture, CALL_LOG: calls, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_FRESH_CAP_MS: '240000' };
let n = 0;
function startServer(roots) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: baseEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, tool, ready };
}
const state = async () => JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'));
const appRows = async () => (await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8').catch(() => '')).split('\n').filter(l => l.includes('/app-content/Datebook/')).length;
const servers = [];
try {
  // 1) a brain that has only a documents folder
  const first = startServer([realDocs]); servers.push(first); await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'setup reaches ready');
  first.child.kill('SIGKILL'); await sleep(1000);
  assert.deepEqual((await log()).filter(l => l === 'full'), [], 'no app was read yet');

  // 2) the Applications folder is added; the app has 60 pages. NO tool call is made from here until the end.
  await write(Array.from({ length: 60 }, (_, i) => row(`x-${i}`, `Added page ${i}`, `addedbody${i} text of page ${i}`, '2026-01-01T10:00:00Z')));
  const second = startServer([realApps, realDocs]); servers.push(second); await second.ready;
  let readyWithoutRows = 0; let worstMs = 0; let since = 0;
  const t0 = Date.now(); let done = false;
  while (!done) {
    assert(Date.now() - t0 < 180000, `timed out: the app rows were never indexed by themselves; stage ${(await state()).stage}, rows ${await appRows()}`);
    const s = await state(); const rows = await appRows();
    const withApps = Array.isArray(s.roots) && s.roots.includes(realApps);
    if (s.stage === 'ready' && withApps && rows < 60) { since ||= Date.now(); worstMs = Math.max(worstMs, Date.now() - since); readyWithoutRows++; } else since = 0;
    done = s.stage === 'ready' && withApps && rows >= 60;
    await sleep(100);
  }
  assert(worstMs < 1500, `the saved stage said ready with app rows missing for ${worstMs} ms (${readyWithoutRows} samples)`);
  assert.equal((await log()).filter(l => l === 'full').length, 1, 'the app was read once');
  const status = await second.tool('databrain_setup_status');
  assert(/Stage: ready/.test(status) && !/being added/.test(status) && /Datebook \(60 items\)/.test(status), `ready only after the app rows are in:\n${status}`);
  assert(/DataBrain is ready/.test(status) && /To check it works, open a new chat and ask: what's in my .+\?/.test(status), `the ready message with the test question appears once the app pass ends:\n${status}`);
  console.log('PASS: adding the Applications folder imports and indexes the apps by itself; the stage is ready only after the app rows are in, with no tool call in between.');
} finally {
  for (const s of servers) s.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
