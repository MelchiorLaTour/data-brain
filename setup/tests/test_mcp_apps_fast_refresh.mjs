// An app change is applied by touching ONLY the changed rows: no scan of the user's own folders, no inventory, no room pages in the update itself.
// New items get a row and are extracted, edited items are re-signed by the full-text update, deleted items lose their rows. Stub app only.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-fastr-')));
const home = path.join(temp, 'home');
await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nfastrsteadymarker an ordinary note.\n');
// a dictionary with its own vocabulary: class "page" (plural "pages"), properties title / text / id / modification date / container / locked
const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
const bundle = path.join(appsDir, 'Datebook.app', 'Contents');
await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
await fs.writeFile(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.datebook</string><key>CFBundleName</key><string>Datebook</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>');
await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);

const fixture = path.join(temp, 'fixture.json'); const calls = path.join(temp, 'calls.log');
const row = (i, t, b, d, extra = {}) => ({ i, t, b, d, c: 'Home', ...extra });
const write = rows => fs.writeFile(fixture, JSON.stringify(rows));
await write([row('x-1', 'First page', 'fastrfirstmarker stays untouched', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'fastrsecondmarker before the edit', '2026-01-02T10:00:00Z'), row('x-3', 'Third page', 'fastrthirdmarker will be deleted', '2026-01-03T10:00:00Z')]);
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
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_RECENT_MS: '0', DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE: fixture, CALL_LOG: calls, DATABRAIN_FRESHNESS_CHECK_MS: '100', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
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


const timing = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => l.split('\t'));
const jobSteps = async (kind, from = 0) => { const rows = (await timing()).slice(from); const ids = [...new Set(rows.filter(f => f[1] === kind && f[3] === 'job-start').map(f => f[2]))]; return ids.map(id => ({ id, steps: rows.filter(f => f[2] === id && /^engine:/.test(f[3])).map(f => f[3].replace('engine:', '')) })); };
const indexText = () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
const servers = [];
try {
  await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nfastrplainmarker an ordinary note.\n');
  await write([row('x-1', 'First page', 'fastrfirstmarker stays untouched', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'fastrsecondmarker before the edit', '2026-01-02T10:00:00Z'), row('x-3', 'Third page', 'fastrthirdmarker will be deleted', '2026-01-03T10:00:00Z')]);
  const s = startServer([realApps, realDocs]); servers.push(s); await setupReady(s);
  await until(async () => (await jobSteps('index housekeeping')).length === 0 || true, 'settled'); await sleep(1500);
  assert((await indexText()).includes('Third page') && (await indexText()).includes('Second page'), 'setup indexed the app pages');

  // an edit, a new page and a deletion, all found by one search
  await write([row('x-1', 'First page', 'fastrfirstmarker stays untouched', '2026-01-01T10:00:00Z'), row('x-2', 'Second page', 'fastrsecondmarker AFTER the edit', '2026-02-02T10:00:00Z'), row('x-4', 'Fourth page', 'fastrfourthmarker brand new page', '2026-02-04T10:00:00Z')]);
  await sleep(300);
  const mark = (await timing()).length;
  const answer = await s.tool('databrain_search', { query: 'fastrfourthmarker' });
  assert(/From your files: Datebook > Home > Fourth page/.test(answer), `the new page is in the first answer:\n${answer}`);
  assert(/From your files: Datebook > Home > Second page/.test(await s.tool('databrain_search', { query: 'fastrsecondmarker AFTER' })), 'the edited page is searchable with its new text');
  const jobs = await jobSteps('refresh', mark);
  assert.equal(jobs.length, 1, `one refresh: ${JSON.stringify(jobs)}`);
  assert.deepEqual(jobs[0].steps.filter(step => !/^(ingest-root|prune-missing|extract|build-fts)\.sh$/.test(step)), [], `only the changed rows were touched, no inventory and no room pages: ${JSON.stringify(jobs[0].steps)}`);
  assert(jobs[0].steps.includes('build-fts.sh') && jobs[0].steps.filter(step => step === 'ingest-root.sh').length === 1, 'one ingest (of the app folder only) and the full-text update');
  const idx = await indexText();
  assert(idx.includes('Fourth page') && idx.includes('Second page') && !idx.includes('Third page'), 'rows: the new page is in, the deleted page lost its row');
  assert(!/fastrthirdmarker/.test(await s.tool('databrain_search', { query: 'fastrthirdmarker' })) || /found nothing|no matches/i.test(await s.tool('databrain_search', { query: 'fastrthirdmarker' })), 'the deleted page is gone from search');
  // the tidying (room pages and inventory) follows in the background, on its own
  await until(async () => (await jobSteps('index housekeeping', mark)).some(job => job.steps.includes('inventory.sh')), 'housekeeping runs rebuild and inventory', 60000);
  // nothing is stale afterwards: the next call finds nothing to do
  await sleep(300);
  const mark2 = (await timing()).length;
  await s.tool('databrain_search', { query: 'fastrplainmarker' });
  assert.equal((await jobSteps('refresh', mark2)).length, 0, 'the baseline was updated: no second refresh');
  assert.deepEqual((await log()).filter(l => l === 'full'), ['full'], 'the app was read in full once (at setup)');
  // a restart reads the apps again; nothing changed in them, so no app file may look edited afterwards (this once cost a 50 s re-index at the first question)
  const mirrorFile = (await (async () => { const out = []; const walk = async f => { for (const e of await fs.readdir(f, { withFileTypes: true }).catch(() => [])) { const full = path.join(f, e.name); if (e.isDirectory()) await walk(full); else out.push(full); } }; await walk(path.join(dataHome, 'app-content')); return out; })())[0];
  const before = await fs.stat(mirrorFile);
  s.child.kill('SIGKILL'); await sleep(1000);
  const again = startServer([realApps, realDocs]); servers.push(again); await again.ready;
  await until(async () => (await timing()).some((f, k) => k >= mark2 && f[1] === 'app check' && f[3] === 'job-end'), 'the app check after the restart finishes', 60000);
  const after = await fs.stat(mirrorFile);
  assert(after.ctimeMs === before.ctimeMs && after.mtimeMs === before.mtimeMs, 'reading the apps again left unchanged app files untouched (same change time)');
  await sleep(300);
  const mark3 = (await timing()).length;
  await again.tool('databrain_search', { query: 'fastrplainmarker' });
  assert.equal((await jobSteps('refresh', mark3)).length, 0, 'after a restart with nothing changed, the first question starts no refresh');
  console.log('PASS: a changed, a new and a deleted app page are applied by touching only those rows (app-folder ingest, extract of the new row, full-text update); no inventory or room pages in the update; deleted rows are dropped; the tidy-up follows in the background; the baseline is kept current.');
} finally {
  for (const x of servers) x.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
