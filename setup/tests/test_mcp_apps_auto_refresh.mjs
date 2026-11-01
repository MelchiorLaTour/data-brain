// Changes are looked for ONLY when a DataBrain tool is called, never on a timer. A change made with no tool call changes nothing. The next
// search indexes the changed items FIRST (files: modified times) and its first answer is already fresh. Only apps that were already read once are re-read during a call, and an
// app whose dictionary has no ids or dates to compare (apps are read through the dictionary only) is re-read at most once an hour. Over the 20 s cap the answer comes from the current index with one plain sentence and the update finishes
// in the background. Stub apps and a stub interpreter only.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-onuse-')));
const home = path.join(temp, 'home');
await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realApps = await fs.realpath(appsDir);
const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nonusesteadymarker an ordinary note.\n');
const sdef = '<dictionary><suite name="S"><class name="memo" code="memo" plural="memos"><property name="name" code="pnam" type="text"/><property name="content" code="ctnt" type="text"/><property name="container" code="ctnr" type="folder"/></class></suite></dictionary>';
async function stubApp(folder, id) {
  const bundle = path.join(appsDir, `${folder}.app`, 'Contents');
  await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleName</key><string>${folder}</string><key>OSAScriptingDefinition</key><string>S.sdef</string></dict></plist>`);
  await fs.writeFile(path.join(bundle, 'Resources', 'S.sdef'), sdef);
}
await stubApp('Scribbler', 'test.scribbler');   // no ids or dates in its dictionary: re-read at most once an hour
await stubApp('Unlisted', 'test.unlisted');     // the same
await stubApp('Guarded', 'test.guarded');       // macOS said no: never re-read during a call
const fixtureA = path.join(temp, 'a.json'); const fixtureB = path.join(temp, 'b.json'); const calls = path.join(temp, 'calls.log');
const write = (file, items) => fs.writeFile(file, JSON.stringify(items.map(([t, b]) => ({ t, b, c: 'Home' }))));
await write(fixtureA, [['Steady memo', 'onuseappsteady stays']]);
await write(fixtureB, [['Other memo', 'onuseotherapp from the app with no data folder']]);
const stub = path.join(temp, 'interpreter-stub.sh');
await fs.writeFile(stub, `#!/bin/bash
case "$4" in
  *Guarded.app*) echo Guarded >> "$CALL_LOG"; echo "execution error: Not authorized to send Apple events to Guarded. (-1743)" >&2; exit 1 ;;
  *Scribbler.app*) echo Scribbler >> "$CALL_LOG"; cat "$FIXTURE_A" ;;
  *Unlisted.app*) echo Unlisted >> "$CALL_LOG"; cat "$FIXTURE_B" ;;
esac
`, { mode: 0o755 });

const dataHome = path.join(home, 'DataBrain');
const timing = path.join(dataHome, '.databrain', 'stage-timing.log');
const count = async re => (await fs.readFile(timing, 'utf8').catch(() => '')).split('\n').filter(line => re.test(line)).length;
const reads = async app => (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(line => line === app).length;
const indexText = () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8').catch(() => '');
const savedStage = async () => JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8')).stage;

function start(env = {}) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], {
    env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE_A: fixtureA, FIXTURE_B: fixtureB, CALL_LOG: calls, DATABRAIN_FRESHNESS_CHECK_MS: '100', ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = ask('initialize', { protocolVersion: '2025-03-26' }).then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
  return { child, tool, ready };
}

let server = null;
try {
  // no timer anywhere in the product that could poll for changes
  assert(!/setInterval\s*\(/.test(await fs.readFile(serverScript, 'utf8')), 'the server must not contain setInterval');

  server = start({ DATABRAIN_TEST_APP_FALLBACK_MS: '3600000' }); await server.ready;
  await server.tool('databrain_setup_start');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'setup reaches ready');
  await sleep(1500);
  const base = { scribbler: await reads('Scribbler'), unlisted: await reads('Unlisted'), guarded: await reads('Guarded'), refreshes: await count(/\trefresh\t[0-9a-f]+\tjob-start/) };
  assert(base.scribbler >= 1 && base.unlisted >= 1 && base.guarded >= 1, 'the first setup read every covered app once');

  // 1) changes with NO tool call: nothing happens, however long we wait
  await write(fixtureA, [['Steady memo', 'onuseappsteady stays'], ['Brand new', 'onusenewappmarker added in the app']]);
  await fs.writeFile(path.join(realDocs, 'late.md'), '# Late\nonusefilemarker written while nobody asked.\n');
  await sleep(6000);
  assert.equal(await reads('Scribbler'), base.scribbler, 'no app was read without a tool call');
  assert.equal(await count(/\trefresh\t[0-9a-f]+\tjob-start/), base.refreshes, 'no refresh ran without a tool call');
  assert(!(await indexText()).includes('late.md') && !(await indexText()).includes('Brand new'), 'the index did not change by itself');

  // 2) the next search indexes the file change FIRST (the first answer is already fresh); an app inside its hour is not asked again
  const appAnswer = await server.tool('databrain_search', { query: 'onusenewappmarker' });
  assert(!/Brand new/.test(appAnswer), `an app read less than an hour ago is not re-read:\n${appAnswer}`);
  assert(!/New changes are being added/.test(appAnswer), 'a quick update needs no "being added" sentence');
  assert.equal(await reads('Scribbler'), base.scribbler, 'no app was re-read inside its hour');
  assert.equal(await reads('Unlisted'), base.unlisted, 'no app was re-read inside its hour');
  assert.equal(await reads('Guarded'), base.guarded, 'an app macOS refused is never re-read during a call');
  assert((await server.tool('databrain_search', { query: 'onusefilemarker' })).includes('late.md'), 'the file change was indexed by the same check');

  // 3) restart with a short fallback: both apps are re-read on a call once their hour (here 4 s) is up, and the refused one is not
  server.child.kill('SIGKILL'); await sleep(1500);
  server = start({ DATABRAIN_TEST_APP_FALLBACK_MS: '4000' }); await server.ready;   // long enough that two searches in a row are one re-read (a call re-reads once the window is up), short enough that the 6 s + 1.5 s of waiting below has used it up
  await sleep(6000);   // the one-time read at extension start happens here
  const afterStart = { scribbler: await reads('Scribbler'), unlisted: await reads('Unlisted'), guarded: await reads('Guarded') };
  await write(fixtureB, [['Other memo', 'onuseotherapp from the app with no data folder'], ['Second', 'onusefallbackmarker changed in the other app']]);
  await sleep(1500);
  assert(/From your files: Unlisted > Home > Second/.test(await server.tool('databrain_search', { query: 'onusefallbackmarker' })), 'the fallback re-read brought the change into the same answer');
  assert(/From your files: Scribbler > Home > Brand new/.test(await server.tool('databrain_search', { query: 'onusenewappmarker' })), 'the other app was re-read too once its hour was up');
  assert.equal(await reads('Unlisted'), afterStart.unlisted + 1, 'the app was re-read once');
  assert.equal(await reads('Guarded'), afterStart.guarded, 'an app macOS refused is still never re-read during a call');

  // 4) over the cap: the answer comes from the current index with one plain sentence, and the update finishes in the background
  server.child.kill('SIGKILL'); await sleep(1500);
  // The update is held for 15 s on purpose: the three calls below take about 1.3 s (search, cap 1.2 s) + 1.3 s (abstain_check) + up to 3 s (setup_status waits for
  // an update in flight, statusWaitMs) = 5.6 s. With a 5 s hold the update could finish inside that last wait, and "no Freshness note" is then CORRECT, so the
  // test failed on timing alone (found 2026-10-17: the job was still running at the call but ended during the status wait; the 0.1.30 package failed it too).
  server = start({ DATABRAIN_TEST_UPDATE_DELAY_MS: '15000', DATABRAIN_TEST_FRESH_CAP_MS: '1200', DATABRAIN_TEST_APP_FALLBACK_MS: '3600000' }); await server.ready;
  await sleep(6000);
  await fs.writeFile(path.join(realDocs, 'slow.md'), '# Slow\nonuseslowmarker added while the update is slow.\n');
  const endsBefore = await count(/\trefresh\t[0-9a-f]+\tjob-end/);
  const t0 = Date.now();
  const slow = await server.tool('databrain_search', { query: 'onuseslowmarker' });
  const took = Date.now() - t0;
  assert(took < 4500, `the answer must not wait for the slow update (${took} ms)`);
  assert(/New changes are being added to the index; these results may not include them yet, and DataBrain will finish by itself\./.test(slow), `one plain sentence:\n${slow}`);
  assert(!slow.includes('slow.md'), 'over the cap the answer comes from the current index');
  // the sentence is the FIRST thing in the result, as a plain Freshness statement (what to do with it is written in the tool description)
  assert(slow.startsWith('Freshness: New changes are being added'), `the sentence comes first in search:\n${slow.slice(0, 400)}`);
  const abstained = await server.tool('databrain_abstain_check', { queries: ['onuseslowmarker', 'slow update marker'] });   // the update is still running
  assert(abstained.startsWith('Freshness: New changes are being added'), `the sentence comes first in abstain_check too:\n${abstained.slice(0, 400)}`);
  assert((await server.tool('databrain_setup_status')).startsWith('Freshness: '), 'status carries it first as well');
  await until(async () => (await count(/\trefresh\t[0-9a-f]+\tjob-end/)) > endsBefore && (await indexText()).includes('slow.md'), 'the update finishes in the background', 90000);
  assert((await server.tool('databrain_search', { query: 'onuseslowmarker' })).includes('slow.md'), 'the next answer has it');
  console.log('PASS: changes are found only when a tool is called; a change with no call does nothing; the first answer already has the change (files and apps); only already-read apps are re-read, at most once an hour; over the 20 s cap the answer says so and the update finishes in the background; no timers.');
} finally {
  server?.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
