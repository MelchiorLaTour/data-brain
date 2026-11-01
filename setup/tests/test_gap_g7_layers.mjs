// Gap G7: which index paths does each Applications layer protect on its own? Four copies of the unzipped 0.1.38 package:
//   both    = as shipped (server filter fileRoots + canon.sh skip)
//   server  = canon.sh skip REMOVED (server filter only)
//   canon   = server filter REMOVED (canon.sh skip only)
//   none    = both removed (control: the 0.1.37 behaviour must leak, otherwise the scenario proves nothing)
// Per variant, in a fresh fake HOME with <HOME>/Applications as the Applications folder: P1 setup, P2 full refresh, P3 automatic/fast
// refresh (freshness on use), P4 app check, P5 note save, P6 source change (Applications added after setup). A path is LEAKED when a file
// lying in the Applications folder ends up in index.tsv or inventory.tsv, or the selected-source health is not PASS. REPORT, no assertion
// except that the "none" control leaks (else the test could not fail).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fakeHome, initialize, sleep, until } from './mcp-harness-0138.mjs';
import { stagePackage } from './mcp-harness-gaps.mjs';


const only = process.env.G7_VARIANTS ? process.env.G7_VARIANTS.split(',') : ['both', 'server', 'canon', 'none'];
async function variantServer(variant, dest) {
  const server = await stagePackage('0.1.38', dest);
  const stage = path.join(dest);
  if (variant === 'server' || variant === 'none') {
    const f = path.join(stage, 'bin', 'canon.sh'); const s = await fs.readFile(f, 'utf8');
    const m = s.replace('if nb_is_applications_dir "$selected_root"; then continue; fi', ':'); assert.notEqual(m, s); await fs.writeFile(f, m);
  }
  if (variant === 'canon' || variant === 'none') {
    const s = await fs.readFile(server, 'utf8');
    const m = s.replace("function fileRoots(roots) { return codexMode ? roots : roots.filter(root => !appReaders.isApplicationsRoot(root)); }", "function fileRoots(roots) { return roots; }"); assert.notEqual(m, s); await fs.writeFile(server, m);
  }
  return server;
}
const results = {};
for (const variant of only) {
  const { temp, home, docs, dataHome, statePath } = await fakeHome(`gap-g7-${variant}`);
  const serverPath = await variantServer(variant, path.join(temp, 'pkg'));
  const apps = path.join(home, 'Applications'); await fs.mkdir(apps, { recursive: true }); const realApps = await fs.realpath(apps);
  const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
  const bundle = path.join(apps, 'Datebook.app', 'Contents');
  await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.datebook</string><key>CFBundleName</key><string>Datebook</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>');
  await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);
  await fs.mkdir(path.join(realApps, 'Pokemon Uranium 1.2.5'));
  await fs.writeFile(path.join(realApps, 'Pokemon Uranium 1.2.5', 'readme.txt'), 'gapsevenmarker setup file.\n');
  await fs.writeFile(path.join(docs, 'plan.md'), '# Plan\ngapsevenmarker ordinary note.\n');
  const fixture = path.join(temp, 'fixture.json'); const calls = path.join(temp, 'calls.log');
  const rowsData = d => [{ i: 'x-1', t: 'Garden plan', b: 'gapsevenmarker tomatoes.', d, c: 'Home' }];
  await fs.writeFile(fixture, JSON.stringify(rowsData('2026-01-02T10:00:00Z')));
  const stub = path.join(temp, 'interpreter-stub.mjs');
  await fs.writeFile(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const script = process.argv[5];
const rows = JSON.parse(fs.readFileSync(process.env.FIXTURE_A, 'utf8'));
const log = line => fs.appendFileSync(process.env.CALL_LOG, line + '\\n');
if (script.includes('// dates only')) { log('dates'); console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) })); }
else if (script.includes('// fetch by id')) { const ids = JSON.parse(script.match(/for \\\\(const id of (\\\\[.*?\\\\])\\\\)/)[1]); log('fetch ' + ids.join(',')); console.log(JSON.stringify(rows.filter(r => ids.includes(r.i)))); }
else if (script.includes('// full read')) { log('full'); console.log(JSON.stringify(rows)); }
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });
  const run = (roots, extra = {}) => {
    const child = spawn(process.execPath, [serverPath, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: realApps, DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE_A: fixture, CALL_LOG: calls, DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_FRESH_CAP_MS: '240000', ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map(); let n = 0;
    readline.createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} });
    const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    return { child, ask, tool: async (name, args = {}) => { const r = await ask('tools/call', { name, arguments: args }); return r.result?.content?.[0]?.text ?? r.error?.message ?? ''; } };
  };
  const idle = server => until(async () => { const t = await server.tool('databrain_setup_status'); if (t.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await server.tool('databrain_privacy', { action: 'decide', keep: [] }); return /Stage: ready\./.test(t) && !/Running now/.test(t); }, 'idle', 240000);
  const read = f => fs.readFile(path.join(dataHome, 'moc', f), 'utf8').catch(() => '');
  const leaks = async () => {
    const hits = [];
    for (const f of ['index.tsv', 'inventory.tsv']) for (const l of (await read(f)).split('\n')) { const p = l.split('\t')[0]; if (p.includes('/Applications/') && !p.includes('app-content')) hits.push(`${f.slice(0, 3)}:${path.basename(p)}`); }
    return hits;
  };
  const healthLine = async server => ((await server.tool('databrain_verify_install')).split('\n').find(l => l.includes('Selected-source health')) || '').split(' — ')[0];
  const out = {};
  const record = async (name, server) => { const l = await leaks(); const h = await healthLine(server); out[name] = l.length || !h.startsWith('PASS') ? `LEAK ${l.join(',') || '-'} / ${h}` : 'protected'; };
  let server;
  try {
    // S1: Applications selected from the start
    server = run([realApps, docs]); await initialize(server);
    await server.tool('databrain_setup_start'); await idle(server); await record('P1 setup', server);
    if (!process.env.G7_FAST) {
    await fs.writeFile(path.join(realApps, 'late-full.txt'), 'gapsevenmarker full refresh file.\n');
    await server.tool('databrain_refresh'); await idle(server); await record('P2 full refresh', server);
    await fs.writeFile(path.join(realApps, 'late-auto.txt'), 'gapsevenmarker automatic refresh file.\n'); await fs.writeFile(path.join(docs, 'trigger.md'), '# Trigger\ngapsevenmarker new doc so the freshness check sees a change.\n');
    for (let i = 0; i < 12; i += 1) { await server.tool('databrain_search', { query: 'gapsevenmarker' }); await sleep(2500); }
    await idle(server); await record('P3 automatic/fast refresh', server);
    }
    try {
      const before = (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
      await fs.writeFile(fixture, JSON.stringify(rowsData('2026-02-02T10:00:00Z')));
      if (process.env.DBG) { await sleep(2000); const r = await server.tool('databrain_search', { query: 'gapsevenmarker' }); console.log('P4 search reply head:', r.slice(0, 300)); console.log('P4 calls:', (await fs.readFile(calls, 'utf8')).split('\n').slice(-6).join('|')); }
      await sleep(400); await server.tool('databrain_search', { query: 'gapsevenmarker' });   // the app check runs on the next tool call
      await until(async () => (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean).slice(before).some(l => l.startsWith('fetch') || l === 'full'), 'app check fetched the changed item', 120000);
      await idle(server); await record('P4 app check', server);
    } catch (error) { out['P4 app check'] = `NOT EXERCISED: the stub never saw a fetch (${String(error.message).slice(0, 60)}); by code this path only ingests the app-content root, see report`; }
    await fs.mkdir(path.join(docs, 'inbox'), { recursive: true });
    await server.tool('databrain_capture', { title: 'Gap seven note', body: 'An invented note.', keywords: ['gapseven', 'note'], folder: path.join(docs, 'inbox') });
    await until(async () => (await server.tool('databrain_setup_status')).includes('note write: complete'), 'note saved', 180000); await idle(server); await record('P5 note save', server);
    server.child.kill('SIGTERM'); await sleep(1500);
  } catch (error) { out.error = String(error.message).slice(0, 200); }
  finally { server?.child.kill('SIGTERM'); }
  // S2: a second fake brain: setup without Applications, then Applications added in the settings (source change)
  try {
    await fs.rm(dataHome, { recursive: true, force: true }); await fs.rm(calls, { force: true });
    await fs.rm(path.join(realApps, 'late-full.txt'), { force: true }); await fs.rm(path.join(realApps, 'late-auto.txt'), { force: true });
    server = run([docs]); await initialize(server);
    await server.tool('databrain_setup_start'); await idle(server);
    server.child.kill('SIGTERM'); await sleep(1500);
    await fs.writeFile(path.join(realApps, 'srcchange.txt'), 'gapsevenmarker source change file.\n');
    server = run([realApps, docs], { DATABRAIN_TEST_CONSENT: 'ask' }); await initialize(server);
    await server.tool('databrain_setup_status'); await sleep(1500);
    await server.tool('databrain_add_sources');
    await server.tool('databrain_add_sources', { confirmed: true });
    await until(async () => ((JSON.parse(await fs.readFile(statePath, 'utf8')).roots) || []).length === 2, 'Applications granted', 60000);
    await server.tool('databrain_setup_run'); await idle(server); await record('P6 source change', server);
  } catch (error) { out.error2 = String(error.message).slice(0, 200); }
  finally { server?.child.kill('SIGTERM'); await sleep(500); await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); }
  results[variant] = out;
  console.log(`G7 ${variant}: ${JSON.stringify(out, null, 1)}`);
}
if (only.includes('none')) assert(Object.values(results.none).some(v => String(v).startsWith('LEAK')), 'control: with both layers removed at least one path leaks');
console.log('G7 DONE');
