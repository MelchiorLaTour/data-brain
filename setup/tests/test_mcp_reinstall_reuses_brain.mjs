// Uninstall, then install again. The extension and its saved settings are gone; the brain folder is still on disk. After the install the user
// picks the folders again (here in another order) and, as the guide's step 10 says, may send "Set up my DataBrain" again.
// The pass condition is RECONNECTION, not only that the folder survived: the same brain folder is reused (no "DataBrain 2"), nothing is
// indexed again from zero, the stage is still ready, and the files are searchable (a known word from each folder is found).
// Invented data, fake HOME; the two installs are two copies of the engine at different paths.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs'));
const engineRoot = path.resolve(path.dirname(serverScript), '../..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-reinstall-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 150000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const noFail = (text, label) => assert(!/^FAIL:/m.test(text), `verify_install must have no FAIL ${label}:\n${text}`);

// "Installing" = putting a copy of the engine in a new folder (the app unpacks the .mcpb into its own folder).
async function install(name) {
  const target = path.join(temp, name);
  const skip = new Set(['scratch', 'research', 'docs', 'windows', '.git', 'Mac download', 'node_modules']);
  await fs.cp(engineRoot, target, { recursive: true, filter: source => !skip.has(path.basename(source)) || source !== path.join(engineRoot, path.basename(source)) });
  return path.join(target, path.relative(engineRoot, serverScript));
}
function start(script, home, roots) {
  const child = spawn(process.execPath, [script, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise((resolve, reject) => {
    const id = ++n; const timer = setTimeout(() => reject(new Error(`timed out: ${method}`)), 90000);
    waiting.set(id, m => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = ask('initialize', { protocolVersion: '2025-03-26' }).then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
  const stop = async () => { child.kill('SIGTERM'); if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve)); };
  return { tool, ready, stop };
}

try {
  const home = path.join(temp, 'home'); await fs.mkdir(home, { recursive: true });
  const folderA = path.join(temp, 'src', 'notes-a'); const folderB = path.join(temp, 'src', 'notes-b');
  await fs.mkdir(folderA, { recursive: true }); await fs.mkdir(folderB, { recursive: true });
  await fs.writeFile(path.join(folderA, 'garden.md'), '# Garden\nreinstallmarkeralpha grows by the fence.\n');
  await fs.writeFile(path.join(folderA, 'bike.md'), '# Bike\nOil the chain every month.\n');
  await fs.writeFile(path.join(folderB, 'boat.md'), '# Boat\nreinstallmarkerbravo hull check before spring.\n');
  await fs.writeFile(path.join(folderB, 'tent.md'), '# Tent\nDry the tent before storing it.\n');
  const [rootA, rootB] = [await fs.realpath(folderA), await fs.realpath(folderB)];
  const dataHome = path.join(await fs.realpath(home), 'DataBrain');
  const statePath = path.join(dataHome, '.databrain', 'desktop-state.json');
  const timingLog = path.join(dataHome, '.databrain', 'stage-timing.log');
  const jobStarts = async () => (await fs.readFile(timingLog, 'utf8').catch(() => '')).split('\n').filter(line => /initial indexing\t[0-9a-f]+\tjob-start/.test(line)).length;
  const indexRows = async () => (await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8')).split('\n').filter(line => line && !line.startsWith('#')).length;

  // ---- first install: a normal setup
  const scriptOne = await install('extension-one');
  const first = start(scriptOne, home, [rootA, rootB]);
  await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => (await first.tool('databrain_setup_status')).includes('DataBrain is ready'), 'the first setup to be ready');
  await first.stop();
  const rowsBefore = await indexRows();
  const indexBefore = createHash('sha256').update(await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'))).digest('hex');
  assert.equal(rowsBefore, 4);
  assert.equal(await jobStarts(), 1, 'sanity: one indexing so far');

  // ---- uninstall: the extension folder and its saved settings are gone; the brain stays on disk
  await fs.rm(path.dirname(path.dirname(path.dirname(scriptOne))) === temp ? path.join(temp, 'extension-one') : path.join(temp, 'extension-one'), { recursive: true, force: true });
  await fs.stat(dataHome);   // the brain folder is still there
  await sleep(500);

  // ---- install again, pick the folders again (other order), and send "Set up my DataBrain"
  const scriptTwo = await install('extension-two');
  assert.notEqual(scriptTwo, scriptOne, 'the second install sits at another path');
  const second = start(scriptTwo, home, [rootB, rootA]);
  try {
    await second.ready;
    const status = await second.tool('databrain_setup_status');
    assert(status.includes('DataBrain is ready'), `the existing brain is reused and ready:\n${status}`);
    const setup = await second.tool('databrain_setup_start');
    const setupAgain = await second.tool('databrain_setup_start', { confirmed: true });
    assert(!/DataBrain 2/.test(`${status}${setup}${setupAgain}`), `no second brain is announced:\n${setup}\n${setupAgain}`);
    await sleep(2500);   // anything that wrongly re-indexes would have started by now
    const entries = await fs.readdir(home);
    assert.deepEqual(entries.filter(name => /^DataBrain/.test(name)), ['DataBrain'], `no second DataBrain folder: ${entries.join(', ')}`);
    const alpha = await second.tool('databrain_search', { query: 'reinstallmarkeralpha' });
    const bravo = await second.tool('databrain_search', { query: 'reinstallmarkerbravo' });
    assert(alpha.includes('garden.md'), `a known word from the first folder is found:\n${alpha}`);
    assert(bravo.includes('boat.md'), `a known word from the second folder is found:\n${bravo}`);
    assert.equal(await jobStarts(), 1, 'nothing was indexed again from zero');
    assert.equal(await indexRows(), rowsBefore, 'the index still has the same rows');
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'))).digest('hex'), indexBefore, 'the index file is byte for byte the same');
    assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).stage, 'ready');
    noFail(await second.tool('databrain_verify_install'), 'after the reinstall');
    const read = await second.tool('databrain_read', { path: path.join(rootA, 'garden.md') });
    assert(read.includes('reinstallmarkeralpha'), `a file can be opened from the reused brain:\n${read}`);
  } finally { await second.stop(); }
  console.log('PASS: after uninstall (extension and saved settings gone, brain folder kept) and a new install with the folders picked again, the EXISTING brain is reused (same folder, no second DataBrain folder, no new indexing, same index bytes, still ready) and a known word from each folder is searchable.');
} finally {
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
