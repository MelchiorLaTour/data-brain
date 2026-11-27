// The Claude app quits (an update, a restart) while extract.sh is busy with a file, or an app read (osascript) waits on Notes/Reminders. Nothing
// of that run may stay behind: no extract.sh, no extractor child, no osascript. Three ways the server can go away: SIGTERM, its input closing, and SIGKILL (no chance to clean up). The extractor is a stub
// that hangs, so the run is guaranteed to be mid-file when the server goes. Processes are found by process group, not by name, so another
// test running extract.sh on this Mac cannot confuse the check.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const processes = () => spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  .map(line => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line); return m && { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] }; }).filter(Boolean);
async function until(check, label, limit = 90000) { for (const t0 = Date.now(); !(await check()); await sleep(100)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

async function scenario(how) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-killx-')));
  const home = path.join(temp, 'home');
  const docs = path.join(home, 'Documents'); await fs.mkdir(docs, { recursive: true });
  const realDocs = await fs.realpath(docs);
  // An engine copy whose PDF extractor hangs. Without pdftotext on the PATH extract.sh uses /usr/bin/osascript on setup/mcp/pdf-extract.js, as on a
  // Mac without pdftotext; here that script just waits. Its path (inside the temp folder) identifies the process.
  const engineDir = path.join(temp, 'engine');
  await fs.cp(path.join(here, '../../bin'), path.join(engineDir, 'bin'), { recursive: true });
  await fs.mkdir(path.join(engineDir, 'setup', 'mcp'), { recursive: true });
  const marker = path.join(engineDir, 'setup', 'mcp', 'pdf-extract.js');
  await fs.writeFile(marker, 'delay(4999);\n');
  await fs.writeFile(path.join(realDocs, 'slow.pdf'), '%PDF-1.4 not a real pdf, the stub hangs on it\n');
  await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nkillxmarker an ordinary note.\n');
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realDocs], { env: { ...process.env, HOME: home, DATABRAIN_ENGINE_DIR: engineDir }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let groups = [];
  try {
    await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await ask('tools/call', { name: 'databrain_setup_start', arguments: {} });
    // mid-extract: the hanging extractor is running, inside an extract.sh that leads its own group
    await until(() => {
      const all = processes();
      const stub = all.find(p => p.command.includes(marker));
      if (!stub) return false;
      groups = [stub.pgid];
      return all.some(p => p.pgid === stub.pgid && /extract\.sh/.test(p.command));
    }, `${how}: extraction starts`);
    const group = groups[0];
    assert(processes().filter(p => p.pgid === group).length >= 2, `${how}: the run leads its own process group`);
    if (how === 'SIGTERM') child.kill('SIGTERM');
    else if (how === 'SIGKILL') child.kill('SIGKILL');
    else child.stdin.end();
    const t0 = Date.now();
    await Promise.race([exited, sleep(8000).then(() => { throw new Error(`${how}: the server did not leave within 8 s`); })]);
    await until(() => processes().every(p => p.pgid !== group), `${how}: the run's processes are gone`, 2000)
      .catch(() => { throw new Error(`${how}: still running 2 s after the server left:\n${processes().filter(p => p.pgid === group).map(p => `${p.pid} ${p.command}`).join('\n')}`); });
    const left = processes().filter(p => /extract\.sh|pdf-extract\.js/.test(p.command) && p.pgid === group);
    assert.deepEqual(left, [], `${how}: no extract.sh or extractor left`);
    return Date.now() - t0;
  } finally {
    child.kill('SIGKILL');
    for (const g of groups) { if (g !== ownGroup) { try { process.kill(-g, 'SIGKILL'); } catch {} } }   // never leave the stub behind, whatever happened
    await sleep(300);
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
  }
}

// extract.sh on its own: TERM sent to the script alone (not its group) must stop it and the extractor under it at once, even though bash is
// busy with a child.
async function scriptAlone() {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-killx-')));
  const engineDir = path.join(temp, 'engine');
  await fs.cp(path.join(here, '../../bin'), path.join(engineDir, 'bin'), { recursive: true });
  await fs.mkdir(path.join(engineDir, 'setup', 'mcp'), { recursive: true });
  const marker = path.join(engineDir, 'setup', 'mcp', 'pdf-extract.js');
  await fs.writeFile(marker, 'delay(4999);\n');
  const root = path.join(temp, 'root'); await fs.mkdir(root);
  const realRoot = await fs.realpath(root);
  const moc = path.join(temp, 'brain', 'moc'); await fs.mkdir(moc, { recursive: true });
  await fs.writeFile(path.join(realRoot, 'slow.pdf'), '%PDF-1.4 stub\n');
  await fs.writeFile(path.join(moc, 'index.tsv'), `${path.join(realRoot, 'slow.pdf')}\tSlow\t-\t-\n`);
  await fs.writeFile(path.join(temp, 'roots.txt'), `${realRoot}\n`);
  const script = spawn('/bin/bash', [path.join(engineDir, 'bin', 'extract.sh')], { env: { PATH: '/usr/bin:/bin', HOME: temp, NB_MOC_DIR: moc, NB_CANON_ROOTS_FILE: path.join(temp, 'roots.txt') }, stdio: 'ignore' });
  const exited = new Promise(resolve => script.once('exit', resolve));
  const tree = () => { const all = processes(); const ids = new Set([script.pid]); for (let grew = true; grew;) { grew = false; for (const p of all) if (ids.has(p.ppid) && !ids.has(p.pid)) { ids.add(p.pid); grew = true; } } return all.filter(p => ids.has(p.pid)); };
  let members = [];
  try {
    await until(() => { members = tree(); return members.some(p => p.command.includes(marker)); }, 'script alone: extraction starts');
    const t0 = Date.now();
    script.kill('SIGTERM');
    await Promise.race([exited, sleep(5000).then(() => { throw new Error('script alone: extract.sh did not leave within 5 s of TERM'); })]);
    await until(() => { const alive = new Set(processes().map(p => p.pid)); return members.every(p => !alive.has(p.pid)); }, 'script alone: its processes are gone', 2000)
      .catch(() => { const alive = new Set(processes().map(p => p.pid)); throw new Error(`script alone: still running 2 s after TERM:\n${members.filter(p => alive.has(p.pid)).map(p => `${p.pid} ${p.command}`).join('\n')}`); });
    return Date.now() - t0;
  } finally {
    for (const p of members) { try { process.kill(p.pid, 'SIGKILL'); } catch {} }
    script.kill('SIGKILL');
    await sleep(300);
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
  }
}

// A Notes/Reminders-style app read (osascript waiting on the app) when the server goes away. The interpreter is a stub that hangs.
const ownGroup = processes().find(p => p.pid === process.pid)?.pgid;
async function appRead(how) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-killx-')));
  const home = path.join(temp, 'home');
  await fs.mkdir(home, { recursive: true });
  const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
  const realApps = await fs.realpath(appsDir);
  const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
  const realDocs = await fs.realpath(docs);
  await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nkillxmarker an ordinary note.\n');
  const sdef = '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="locked" code="lock" type="boolean"/></class></suite></dictionary>';
  const bundle = path.join(appsDir, 'Datebook.app', 'Contents');
  await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.datebook</string><key>CFBundleName</key><string>Datebook</string><key>OSAScriptingDefinition</key><string>D.sdef</string></dict></plist>');
  await fs.writeFile(path.join(bundle, 'Resources', 'D.sdef'), sdef);
  const stub = path.join(temp, 'hanging-interpreter.mjs');
  await fs.writeFile(stub, '#!/usr/bin/env node\nsetTimeout(() => {}, 300000);\n', { mode: 0o755 });
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realApps, realDocs], { env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: realApps, DATABRAIN_TEST_APP_OSASCRIPT: stub }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let group = null;
  try {
    await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const started = ask('tools/call', { name: 'databrain_setup_start', arguments: {} });   // not awaited: it returns when the app read ends
    started.then(m => { if (process.env.DEBUG_KILLX) console.log(JSON.stringify(m).slice(0, 600)); });
    await until(() => { const read = processes().find(p => p.command.includes(stub)); if (!read) return false; group = read.pgid; return true; }, `app read (${how}): the read starts`);
    const serverGroup = processes().find(p => p.pid === child.pid)?.pgid;
    assert(group !== serverGroup && group !== ownGroup, `app read (${how}): the read has its own process group, not the server's or the test's`);
    const t0 = Date.now();
    if (how === 'SIGTERM') child.kill('SIGTERM'); else if (how === 'SIGKILL') child.kill('SIGKILL'); else child.stdin.end();
    await Promise.race([exited, sleep(8000).then(() => { throw new Error(`app read (${how}): the server did not leave within 8 s`); })]);
    await until(() => processes().every(p => p.pgid !== group), `app read (${how}): the read's processes are gone`, 2000)
      .catch(() => { throw new Error(`app read (${how}): still running 2 s after the server left:\n${processes().filter(p => p.pgid === group).map(p => `${p.pid} ${p.command}`).join('\n')}`); });
    return Date.now() - t0;
  } finally {
    child.kill('SIGKILL');
    if (group && group !== ownGroup) { try { process.kill(-group, 'SIGKILL'); } catch {} }   // never the test's own group
    await sleep(300);
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
  }
}

const took = [];
for (const how of ['SIGTERM', 'stdin closed', 'SIGKILL']) took.push(`app read ${how} ${await appRead(how)} ms`);
took.push(`script alone ${await scriptAlone()} ms`);
for (const how of ['SIGTERM', 'stdin closed', 'SIGKILL']) took.push(`${how} ${await scenario(how)} ms`);
console.log(`PASS: the server going away mid-extract (${took.join(', ')}) leaves no extract.sh, no extractor and no app read behind.`);
