// An app whose dictionary describes people or events is not read at all (no question to it, so no permission prompt), and status says so in
// one plain sentence; an ordinary app next to it is still read. Stub apps and a stub interpreter; no real app is touched.
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
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nskipsteadymarker an ordinary note.\n');
const makeApp = async (name, id, sdef) => {
  const bundle = path.join(appsDir, `${name}.app`, 'Contents');
  await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleName</key><string>${name}</string><key>OSAScriptingDefinition</key><string>X.sdef</string></dict></plist>`);
  await fs.writeFile(path.join(bundle, 'Resources', 'X.sdef'), sdef);
};
await makeApp('Peoplebook', 'test.peoplebook', '<dictionary><suite name="S"><class name="contact" code="ctct" plural="contacts"><property name="name" code="pnam" type="text"/><property name="note" code="note" type="text"/><property name="id" code="ID  " type="text" access="r"/></class></suite></dictionary>');
await makeApp('Pagebook', 'test.pagebook', '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/></class></suite></dictionary>');
const calls = path.join(temp, 'calls.log');
const stub = path.join(temp, 'interpreter-stub.mjs');
await fs.writeFile(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const script = process.argv[5];
fs.appendFileSync(process.env.CALL_LOG, (script.includes('Peoplebook') ? 'PEOPLEBOOK' : 'pagebook') + '\\n');
if (script.includes('// full read')) console.log(JSON.stringify([{ i: 'g-1', t: 'A page', b: 'skippagemarker written body', d: '2026-01-01T10:00:00Z', c: 'Home' }]));
else if (script.includes('// dates only')) console.log(JSON.stringify({ ids: ['g-1'], d: ['2026-01-01T10:00:00Z'] }));
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });
const dataHome = path.join(home, 'DataBrain');
const savedStage = async () => JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8')).stage;

const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], { env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, CALL_LOG: calls, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_FRESH_CAP_MS: '240000' }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
let n = 0;
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
try {
  await ask('initialize', { protocolVersion: '2025-03-26' });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'setup reaches ready (nothing is held for review)', 240000);
  const status = await tool('databrain_setup_status');
  assert(status.includes('Contacts and calendars are not read, to protect your private information.'), `status says it in one sentence:\n${status.slice(0, 1500)}`);
  assert(/Included apps: Pagebook \(1 item\)/.test(status), `the ordinary app is still read:\n${status.slice(0, 1500)}`);
  // searches (which also run the on-use check) never reach the people app either
  await tool('databrain_search', { query: 'skippagemarker' }); await sleep(300); await tool('databrain_search', { query: 'skippagemarker' });
  const asked = (await fs.readFile(calls, 'utf8')).split('\n').filter(Boolean);
  assert(asked.includes('pagebook'), 'the ordinary app was asked');
  assert(!asked.includes('PEOPLEBOOK'), `the people app was never asked anything: ${JSON.stringify(asked)}`);
  await fs.access(path.join(dataHome, 'app-content', 'Peoplebook')).then(() => assert.fail('nothing of the people app is in the DataBrain folder'), () => {});
  assert.equal((await tool('databrain_privacy', { action: 'list' })).includes('Peoplebook'), false, 'nothing from the people app is held for review either');
  assert(/From your files: Pagebook/.test(await tool('databrain_search', { query: 'skippagemarker' })), 'the ordinary app is searchable');
  console.log('PASS: an app with people or events in its dictionary is never asked anything and status says so; an ordinary app next to it is still read');
} finally {
  child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
