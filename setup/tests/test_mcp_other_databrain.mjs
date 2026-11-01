// Another "databrain" server switched on in Claude Desktop (found by READING claude_desktop_config.json, never by opening the other brain):
// one plain line comes first in status and in the first search of a chat. Fake HOME only; the config file is never changed.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-other-')));
const home = path.join(temp, 'home');
await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nothersteadymarker an ordinary note.\n');
// a dictionary with its own vocabulary: class "page" (plural "pages"), properties title / text / id / modification date / container / locked
const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
const bundle = path.join(appsDir, 'Datebook.app', 'Contents');
await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
await fs.writeFile(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.datebook</string><key>CFBundleName</key><string>Datebook</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>');
await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);

const fixture = path.join(temp, 'fixture.json'); const calls = path.join(temp, 'calls.log');
const row = (i, t, b, d, extra = {}) => ({ i, t, b, d, c: 'Home', ...extra });
const write = rows => fs.writeFile(fixture, JSON.stringify(rows));
await write([row('x-1', 'First page', 'otherfirstmarker stays untouched', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'othersecondmarker before the edit', '2026-01-02T10:00:00Z'), row('x-3', 'Third page', 'otherthirdmarker will be deleted', '2026-01-03T10:00:00Z')]);
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

const configPath = path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
const LINE = 'Another DataBrain connection is installed in Claude. If it is switched on in a chat, answers there may come from it.';
const servers = [];
try {
  await write([row('x-1', 'First page', 'otherbodymarker of the app page', '2026-01-01T10:00:00Z')]);
  // A) no config at all, then a config with unrelated servers: no line anywhere
  const a = startServer([realApps, realDocs]); servers.push(a); await setupReady(a);
  assert(!(await a.tool('databrain_setup_status')).includes(LINE), 'no config file: no line');
  a.child.kill('SIGKILL'); await sleep(800);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const unrelated = JSON.stringify({ mcpServers: { github: { command: '/usr/local/bin/gh-mcp', args: ['--stdio'] }, files: { command: 'npx', args: ['some-files-server'] } } });
  await fs.writeFile(configPath, unrelated);
  const b = startServer([realApps, realDocs]); servers.push(b); await b.ready;
  assert(!(await b.tool('databrain_setup_status')).includes(LINE), 'unrelated servers in the config: no line');
  assert(!(await b.tool('databrain_search', { query: 'otherbodymarker' })).includes(LINE), 'unrelated servers: no line in search');
  b.child.kill('SIGKILL'); await sleep(800);

  // B) an entry named databrain whose command points at another brain
  const mine = JSON.stringify({ mcpServers: { databrain: { command: '/bin/sh', args: ['/Users/someone/Claude/mcp/bundles/databrain/server/run.sh', '/Users/someone/PrivateBrain'] } } });
  await fs.writeFile(configPath, mine); const before = await fs.readFile(configPath);
  const c = startServer([realApps, realDocs], { DATABRAIN_TEST_CHAT_GAP_MS: '1500' }); servers.push(c); await c.ready;
  const status = await c.tool('databrain_setup_status');
  assert(status.startsWith(LINE), `the line is the FIRST thing in status:\n${status.slice(0, 300)}`);
  assert(!/PrivateBrain|someone|run\.sh/.test(status), 'the other brain is never named');
  const first = await c.tool('databrain_search', { query: 'otherbodymarker' });
  assert(first.startsWith(LINE), `first search of the chat carries it first:\n${first.slice(0, 300)}`);
  const second = await c.tool('databrain_search', { query: 'otherbodymarker' });
  assert(!second.includes(LINE), 'not repeated on every search');
  assert((await c.tool('databrain_setup_status')).startsWith(LINE), 'status always carries it');
  await sleep(1800);   // a quiet spell: the next chat
  assert((await c.tool('databrain_search', { query: 'otherbodymarker' })).startsWith(LINE), 'carried again after a quiet spell (a new chat)');
  assert.deepEqual(await fs.readFile(configPath), before, 'the config file was never changed');
  c.child.kill('SIGKILL'); await sleep(800);

  // C) an entry whose NAME is harmless but whose command path holds databrain
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { notes: { command: '/opt/databrain/bin/serve', args: [] } } }));
  const d = startServer([realApps, realDocs]); servers.push(d); await d.ready;
  assert((await d.tool('databrain_setup_status')).startsWith(LINE), 'a command path with databrain counts too');
  console.log('PASS: another databrain server in the Claude config puts one plain line first in status and in the first search of a chat; no entry or unrelated entries: no line; the other brain is never named or opened; the config file is never changed.');
} finally {
  for (const s of servers) s.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
