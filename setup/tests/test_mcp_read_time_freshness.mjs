// Read-time freshness (Mel's rule, 2026-10-12): when an answer comes from an item that was edited after it was indexed, the current version is
// used, and it goes through the same privacy screen as indexing. The on-use check is held off for an hour here, so the index stays old
// (stand-in for "indexing blocked"); only the per-hit comparison can find the edit.
//   A) a note edited lemon -> lime: search flags the hit, read returns lime (not lemon); an untouched note is not flagged and reads as before;
//   B) a note edited to hold an IBAN: read returns nothing from it (held), the number never appears, the file is on the held list;
//   C) an app item edited in the app (app date newer): read returns the app's current text; an app item edited to hold an IBAN is held;
//   D) the index refresh still follows: the next call indexes the edits and the flag disappears.
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
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nreadsteadymarker an ordinary note.\n');
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
for (const name of APPS) await writeRows(name, [rowFor(`${name}-1`, 'First page', `read${name.toLowerCase()}first stays`, '2026-01-01T10:00:00Z'), rowFor(`${name}-2`, 'Second page', `read${name.toLowerCase()}second before`, '2026-01-02T10:00:00Z')]);
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
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], { env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_RECENT_MS: '0', DATABRAIN_TEST_APP_OSASCRIPT: stub, ROWS_DIR: temp, DATABRAIN_FRESHNESS_CHECK_MS: '3600000', DATABRAIN_TEST_FRESH_CAP_MS: '12000', DATABRAIN_TEST_STATUS_WAIT_MS: '1000' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const note = (name, text) => fs.writeFile(path.join(realDocs, name), text);
  // the first tool call after setup is the one that makes the hour-long on-use check; spend it before the edits
  await server.tool('databrain_search', { query: 'readsteadymarker' });
  await settle();

  // A) lemon -> lime
  await note('zorblat.md', '# Zorblat soup\nzorblat soup: 3 carrots, 1 lemon\n');
  await fs.writeFile(path.join(realDocs, 'untouched.md'), '# Untouched\nzorblat untouched pantry list: rice, beans\n');
  await server.tool('databrain_refresh'); await settle();
  await until(async () => /zorblat\.md/.test(await server.tool('databrain_search', { query: 'zorblat' })), 'both notes indexed', 60000);
  await settle();
  await sleep(1100);
  await note('zorblat.md', '# Zorblat soup\nzorblat soup: 3 carrots, 1 lime\n');
  const hits = await server.tool('databrain_search', { query: 'zorblat' });
  const hitPath = /(\/[^\s]*zorblat\.md)/.exec(hits)?.[1];
  assert(hitPath, `the edited note is a search hit:\n${hits}`);
  const flagged = hits.split('\n');
  const flagAfter = name => { const i = flagged.findIndex(l => l.includes(name) && /^\s*\d+\s/.test(l)); return flagged[i + 1] || ''; };
  assert(/edited since it was indexed/.test(flagAfter('zorblat.md')), `the edited hit carries the fact that it was edited:\n${hits}`);
  assert(!/edited since it was indexed/.test(flagAfter('untouched.md')), `an untouched hit is not flagged:\n${hits}`);
  const readNew = await server.tool('databrain_read', { path: hitPath });
  assert(/1 lime/.test(readNew) && !/lemon/.test(readNew), `read answers from the current text (lime, not lemon):\n${readNew}`);
  assert(/Edited after it was indexed/.test(readNew), 'and says that it is the current text');
  const untouchedPath = /(\/[^\s]*untouched\.md)/.exec(hits)?.[1];
  const readOld = await server.tool('databrain_read', { path: untouchedPath });
  assert(/rice, beans/.test(readOld) && !/Edited after it was indexed/.test(readOld), `an untouched note reads as before:\n${readOld}`);

  // B) edited to hold an IBAN
  await sleep(1100);
  await note('zorblat.md', '# Zorblat soup\nzorblat soup: 3 carrots, 1 lime. refund account FR7630006000011234567890189\n');
  const readHeld = await server.tool('databrain_read', { path: hitPath });
  assert(!/FR76|3000600001|carrots/.test(readHeld), `the edit that holds an IBAN returns nothing from the file:\n${readHeld}`);
  assert(/holds it back|looks private/.test(readHeld), `and says plainly that it is held:\n${readHeld}`);
  const privacyList = await server.tool('databrain_privacy', { action: 'list' });
  assert(/zorblat\.md/.test(privacyList), `the file is on the held list:\n${privacyList.slice(0, 300)}`);

  // C) an app item edited in the app
  await writeRows('Datebook', [rowFor('Datebook-1', 'First page', 'readdatebookfirst stays', '2026-01-01T10:00:00Z'), rowFor('Datebook-2', 'Second page', 'readdatebooksecond now has lime', '2026-05-05T10:00:00Z')]);
  const appHits = await server.tool('databrain_search', { query: 'readdatebooksecond' });
  const appPath = /^\s*\d+\s+-?[0-9.]+\s+(.+Second page.*\.md)\s*$/m.exec(appHits)?.[1];
  assert(appPath, `the app item is a hit:\n${appHits}`);
  const readApp = await server.tool('databrain_read', { path: appPath });
  assert(/now has lime/.test(readApp) && !/second before/.test(readApp), `read gives the app's current text:\n${readApp}`);
  await writeRows('Datebook', [rowFor('Datebook-1', 'First page', 'readdatebookfirst stays', '2026-01-01T10:00:00Z'), rowFor('Datebook-2', 'Second page', 'readdatebooksecond refund FR7630006000011234567890189', '2026-06-06T10:00:00Z')]);
  const readAppHeld = await server.tool('databrain_read', { path: appPath });
  assert(!/FR76|3000600001/.test(readAppHeld) && /holds it back|looks private/.test(readAppHeld), `an app edit that holds an IBAN is held:\n${readAppHeld}`);

  // D) the refresh still follows
  const next = await server.tool('databrain_search', { query: 'zorblat' });
  assert(!/edited since it was indexed/.test(next.split('\n').filter(l => /untouched/.test(l)).join('')), 'no stale flag on the untouched note');
  await settle();
  const after = await server.tool('databrain_search', { query: 'readdatebookfirst' });
  assert(/Datebook > Home > First page/.test(after), `the index refresh ran after the live reads:\n${after.slice(0, 300)}`);

  console.log('PASS: an edited hit is flagged in search and read from the file (lime, not lemon); an untouched hit reads as before; an edit that adds an IBAN is held and never returned (file and app item); an app item newer in the app is read live; the refresh still follows.');
} finally {
  server?.child.kill('SIGKILL');
  await sleep(1200);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
