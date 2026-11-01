// DataBrain repair (0.1.48). The client's Claude once hit "An approved source folder changed identity", could not even run diagnostics, and
// improvised fixes that could not work. Now: diagnostics and databrain_repair always answer, and repair fixes every known break in one call.
// Invented data, fake HOME. Hooks that switch the automatic passes off (renumber heal, labelling, maintenance) are set on purpose, so only repair
// can do the fixing; after repair a normal server must work as well.
//   S1 every known break at once (renumbered disk, stale lock, dead job record with a reused PID, unlabeled row at verification pending, empty search database)
//   S2 a stage an interrupted job left behind (indexing, no job)
//   S3 missing and unreadable search database
//   S4 repair on a healthy brain changes no data and starts no indexing
//   S5 a replaced folder: refused before; diagnostics and repair answer; reapprove for a listed folder works; for an unlisted folder it is refused
//   S6 a revoked root plus a replaced folder: diagnostics and repair still answer; reapprove refuses a folder that is not in the settings list
//   S7 remove-save-add in Settings (the no-AI path) with two folders
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
delete process.env.DATABRAIN_TEST_NO_RENUMBER_HEAL;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-repair-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 150000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const REPAIR_LINE = 'DataBrain repair is available: ask Claude to run DataBrain repair.';
const kids = [];

function start(home, parent, roots, env = {}) {
  const child = spawn(process.execPath, [serverScript, '--databrain-parent', parent, '--databrain-source-roots', ...roots],
    { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise((resolve, reject) => {
    const id = ++n; const timer = setTimeout(() => reject(new Error(`timed out: ${method}`)), 120000);
    waiting.set(id, m => { clearTimeout(timer); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = ask('initialize', { protocolVersion: '2025-03-26' }).then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
  const stop = async () => { child.kill('SIGTERM'); if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve)); };
  const list = async () => (await ask('tools/list', {})).result.tools;
  return { child, tool, ready, stop, list };
}
const noFail = (text, label = '') => assert(!/^FAIL:/m.test(text), `verify_install must have no FAIL ${label}:\n${text}`);

async function makeBrain(label, rootSpecs) {
  const base = path.join(temp, label);
  const home = path.join(base, 'home'); const parent = path.join(base, 'parent');
  await fs.mkdir(home, { recursive: true }); await fs.mkdir(parent, { recursive: true });
  const roots = [];
  for (const [name, files] of rootSpecs) {
    const dir = path.join(base, 'src', name);
    await fs.mkdir(dir, { recursive: true });
    for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(dir, file), text);
    roots.push(await fs.realpath(dir));
  }
  const dataHome = path.join(await fs.realpath(parent), 'DataBrain');
  const brain = {
    home, parent, roots, dataHome,
    statePath: path.join(dataHome, '.databrain', 'desktop-state.json'),
    tsvPath: path.join(dataHome, '.databrain', 'root-identities.tsv'),
    timingLog: path.join(dataHome, '.databrain', 'stage-timing.log'),
    moc: path.join(dataHome, 'moc'),
    start: (use = roots, env = {}) => start(home, parent, use, env),
    state: async () => JSON.parse(await fs.readFile(brain.statePath, 'utf8')),
    setState: async state => fs.writeFile(brain.statePath, `${JSON.stringify(state, null, 2)}\n`),
    rows: async () => (await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8')).split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t')),
    jobStarts: async kind => (await fs.readFile(brain.timingLog, 'utf8').catch(() => '')).split('\n').filter(line => line.includes(`${kind}\t`) && line.includes('\tjob-start')).length,
  };
  const first = brain.start();
  await first.ready;
  await first.tool('databrain_setup_start');
  await until(async () => (await first.tool('databrain_setup_status')).includes('DataBrain is ready'), `${label}: the first setup to be ready`);
  await first.stop();
  return brain;
}
async function renumber(brain) {
  const state = await brain.state();
  state.rootIdentities = state.rootIdentities.map(entry => ({ ...entry, dev: entry.dev + 2 }));
  await brain.setState(state);
  await fs.writeFile(brain.tsvPath, state.rootIdentities.map(({ path: p, dev, ino }) => `${p}\t${dev}:${ino}`).join('\n') + '\n');
  const baselinePath = path.join(brain.moc, 'source-freshness.tsv');
  const baseline = await fs.readFile(baselinePath, 'utf8').catch(() => null);
  if (baseline) await fs.writeFile(baselinePath, baseline.split('\n').map((line, i) => {
    if (i === 0 || !line) return line;
    const [file, dev, ...rest] = line.split('\t');
    return /^\d+$/.test(dev) ? [file, String(Number(dev) + 2), ...rest].join('\t') : line;
  }).join('\n'));
}
async function replaceFolder(dir) {   // a new inode at the same path: restored from a backup, moved by iCloud, deleted and created again
  await fs.rename(dir, `${dir}-old`);
  await fs.cp(`${dir}-old`, dir, { recursive: true });
}
const hash = async file => createHash('sha256').update(await fs.readFile(file).catch(() => 'missing')).digest('hex');

try {
  // ---------- S1: every known break at once ----------
  {
    const brain = await makeBrain('s1', [['notes', { 'garden.md': '# Garden\nrepairmarkeralpha grows by the fence.\n', 'bike.md': '# Bike\nOil the chain every month.\n', 'boat.md': '# Boat\nCheck the hull before spring.\n' }]]);
    const [root] = brain.roots;
    await renumber(brain);
    const sleeper = spawn('/bin/sleep', ['600'], { stdio: 'ignore' }); kids.push(sleeper);   // a live process of the same user: a "reused" PID
    const lock = path.join(brain.moc, 'index.tsv.lock');
    await fs.mkdir(lock); await fs.writeFile(path.join(lock, 'pid'), `${sleeper.pid}\n`);
    const old = new Date('2000-01-01T00:00:00Z'); await fs.utimes(lock, old, old);
    const state = await brain.state();
    state.indexJob = { id: 'dead-job', kind: 'refresh', status: 'running', ownerPid: sleeper.pid, enginePid: sleeper.pid, engineScript: 'extract.sh' };
    state.stage = 'verification pending';
    await brain.setState(state);
    const indexPath = path.join(brain.moc, 'index.tsv');
    const text = await fs.readFile(indexPath, 'utf8');
    await fs.writeFile(indexPath, text.split('\n').map(line => line.includes('bike.md') ? line.split('\t').map((col, i) => i === 2 ? '-' : col).join('\t') : line).join('\n'));
    await fs.truncate(path.join(brain.moc, 'fts.db'), 0);

    const broken = brain.start(brain.roots, { DATABRAIN_TEST_NO_RENUMBER_HEAL: '1', DATABRAIN_TEST_NO_AUTO_LABELS: '1' });
    try {
      await broken.ready;
      const tools = (await broken.list()).map(tool => tool.name);
      assert(tools.includes('databrain_repair'), 'repair is offered as a tool');
      const refused = await broken.tool('databrain_search', { query: 'repairmarkeralpha' });
      assert(/changed identity/.test(refused), `the broken brain refuses reads (sanity):\n${refused}`);
      assert(refused.includes(REPAIR_LINE), `an error that can follow a restart ends with the repair line:\n${refused}`);
      assert(!/Select it again/i.test(refused), 'no false fix is offered');
      const verifyBefore = await broken.tool('databrain_verify_install');
      assert(verifyBefore.includes(REPAIR_LINE), `verify_install states that repair is available when it cannot pass:\n${verifyBefore}`);
      const diagnostics = await broken.tool('databrain_diagnostics');
      assert(diagnostics.startsWith('DataBrain diagnostics.'), `diagnostics answers while root validation would throw:\n${diagnostics}`);
      assert(/disk number changed/.test(diagnostics) && diagnostics.includes(REPAIR_LINE), `diagnostics reports the problem as a fact:\n${diagnostics}`);

      const repaired = await broken.tool('databrain_repair');
      assert(/Disk number:/.test(repaired), `repair names the disk number fix:\n${repaired}`);
      assert(/Index lock:/.test(repaired), `repair names the lock fix:\n${repaired}`);
      assert(/Job record:/.test(repaired), `repair names the dead job record:\n${repaired}`);
      assert(/Labels:/.test(repaired), `repair names the labelling:\n${repaired}`);
      assert(/Still wrong: nothing\./.test(repaired), `nothing is left wrong:\n${repaired}`);
      assert(/, 0 FAIL,/.test(repaired), `the checks ran and none fails:\n${repaired}`);
      const after = await brain.state();
      const stat = await fs.stat(root);
      assert.deepEqual(after.rootIdentities, [{ path: root, dev: stat.dev, ino: stat.ino }], 'the saved folder record describes the folder again');
      assert.equal((await fs.readFile(brain.tsvPath, 'utf8')).trim(), `${root}\t${stat.dev}:${stat.ino}`, 'the identity grant file is healed too');
      await assert.rejects(fs.stat(lock), 'the stale lock folder is gone');
      assert.equal(after.indexJob.status, 'failed', 'the dead job record is marked as stopped');
      assert.equal(after.stage, 'ready', 'the brain is ready again');
      assert((await brain.rows()).every(cols => cols[2] && cols[2] !== '-'), 'every row carries a label');
      assert((await fs.stat(path.join(brain.moc, 'fts.db'))).size > 0, 'the search database is back');
      noFail(await broken.tool('databrain_verify_install'), 'after repair');
      assert((await broken.tool('databrain_search', { query: 'repairmarkeralpha' })).includes('garden.md'), 'search finds the known word');
    } finally { await broken.stop(); }

    // capture still works on a normal server (no hooks)
    const normal = brain.start();
    try {
      await normal.ready;
      const saved = await normal.tool('databrain_capture', { title: 'After repair', body: 'A note written after the repair.', keywords: ['afterrepair', 'note'], folder: root });
      assert(/Save job/.test(saved), saved);
      let status = '';
      await until(async () => /note write: (complete|failed)/.test(status = await normal.tool('databrain_setup_status')), 'the save job to finish');
      assert(/note write: complete/.test(status), `the capture's save job completes after repair:\n${status}`);
      await until(async () => (await normal.tool('databrain_search', { query: 'afterrepair' })).includes('After repair'), 'the capture to be searchable');
      await until(async () => (await brain.state()).stage === 'ready', 'ready after the capture');
      noFail(await normal.tool('databrain_verify_install'), 'after capture');
    } finally { await normal.stop(); }
    sleeper.kill('SIGKILL');
  }

  // ---------- S2: a stage an interrupted job left behind ----------
  {
    const brain = await makeBrain('s2', [['notes', { 'one.md': '# One\nstagemarkerone text.\n', 'two.md': '# Two\nsecond note.\n' }]]);
    const state = await brain.state();
    await brain.setState({ ...state, stage: 'indexing', indexFailures: { count: 5, step: 'the indexing run', stopped: true, nextRetryAt: new Date().toISOString() } });
    const startsBefore = await brain.jobStarts('initial indexing');
    const server = brain.start(brain.roots, { DATABRAIN_TEST_NO_AUTO_LABELS: '1' });   // no automatic labelling or promotion; repair is called before the 3 s start-up pass could resume the indexing
    try {
      await server.ready;
      const repaired = await server.tool('databrain_repair');
      assert(/Indexing:/.test(repaired), `repair names the resumed indexing:\n${repaired}`);
      assert(/Still wrong: nothing\./.test(repaired), repaired);
      assert.equal(await brain.jobStarts('initial indexing'), startsBefore + 1, 'indexing was resumed once');
      assert.equal((await brain.state()).stage, 'ready', 'the brain got from the wrong stage to ready');
      noFail(await server.tool('databrain_verify_install'), 'S2');
      assert((await server.tool('databrain_search', { query: 'stagemarkerone' })).includes('one.md'));
    } finally { await server.stop(); }
  }

  // ---------- S3: missing, then unreadable search database ----------
  {
    const brain = await makeBrain('s3', [['notes', { 'a.md': '# A\nftsmarkerone lives here.\n', 'b.md': '# B\nanother note.\n' }]]);
    const server = brain.start();
    try {
      await server.ready;
      const ftsPath = path.join(brain.moc, 'fts.db');
      await fs.rm(ftsPath);
      const before = await server.tool('databrain_verify_install');
      assert(/^FAIL:/m.test(before) && before.includes(REPAIR_LINE), `a missing search database fails the audit and says repair is available:\n${before}`);
      const first = await server.tool('databrain_repair');
      assert(/Search database: it was missing/.test(first), first);
      noFail(await server.tool('databrain_verify_install'), 'after the rebuild');
      assert((await server.tool('databrain_search', { query: 'ftsmarkerone' })).includes('a.md'));
      await fs.writeFile(ftsPath, Buffer.from('this is not a database '.repeat(400)));
      const second = await server.tool('databrain_repair');
      assert(/Search database: it was unreadable/.test(second), second);
      noFail(await server.tool('databrain_verify_install'), 'after the second rebuild');
      assert((await server.tool('databrain_search', { query: 'ftsmarkerone' })).includes('a.md'));
    } finally { await server.stop(); }
  }

  // ---------- S4: repair on a healthy brain is harmless ----------
  {
    const brain = await makeBrain('s4', [['notes', { 'a.md': '# A\nhealthymarker is here.\n', 'b.md': '# B\nanother note.\n', 'c.md': '# C\na third note.\n' }]]);
    const server = brain.start();
    try {
      await server.ready;
      await server.tool('databrain_setup_status');
      await sleep(4000);   // let the start-up maintenance pass finish before the snapshot
      const files = [brain.statePath, brain.tsvPath, path.join(brain.moc, 'index.tsv'), path.join(brain.moc, 'fts.db'), path.join(brain.moc, 'relationships.tsv'), path.join(brain.moc, 'source-freshness.tsv'), path.join(brain.dataHome, '.databrain', 'roots.tsv')];
      const snapshot = async () => Promise.all(files.map(hash));
      const extracted = async () => (await fs.readdir(path.join(brain.moc, 'extracted')).catch(() => [])).sort().join(',');
      const before = await snapshot(); const extractedBefore = await extracted();
      const startsBefore = [await brain.jobStarts('initial indexing'), await brain.jobStarts('refresh')];
      for (const round of [1, 2]) {
        const repaired = await server.tool('databrain_repair');
        assert(/Fixed: nothing needed fixing\./.test(repaired), `round ${round}: a healthy brain has nothing to fix:\n${repaired}`);
        assert(/Still wrong: nothing\./.test(repaired) && /, 0 FAIL,/.test(repaired), repaired);
      }
      assert.deepEqual(await snapshot(), before, 'no saved file changed (state, identities, index, search database, relationships, freshness)');
      assert.equal(await extracted(), extractedBefore, 'no extracted text was added or removed');
      assert.deepEqual([await brain.jobStarts('initial indexing'), await brain.jobStarts('refresh')], startsBefore, 'no indexing or refresh was started');
    } finally { await server.stop(); }
  }

  // ---------- S5: a replaced folder ----------
  {
    const brain = await makeBrain('s5', [['notes', { 'a.md': '# A\nreplacedmarker is here.\n', 'b.md': '# B\nanother note.\n' }]]);
    const [root] = brain.roots;
    await replaceFolder(root);
    const startsBefore = await brain.jobStarts('initial indexing');
    const server = brain.start();   // exactly what Settings does after "remove, add again, Save": the same list
    try {
      await server.ready;
      const refused = await server.tool('databrain_search', { query: 'replacedmarker' });
      assert(/changed identity/.test(refused) && refused.includes(REPAIR_LINE) && !/Select it again/i.test(refused), `a replaced folder is refused, with the repair line:\n${refused}`);
      assert(!refused.includes('a.md'), 'nothing is read from a replaced folder');
      const diagnostics = await server.tool('databrain_diagnostics');
      assert(/a different folder now sits at this path/.test(diagnostics) && diagnostics.includes(REPAIR_LINE), `diagnostics answers and names the replaced folder:\n${diagnostics}`);
      const stateBytes = await hash(brain.statePath); const tsvBytes = await hash(brain.tsvPath);
      const plain = await server.tool('databrain_repair');
      assert(/Only the user can fix:/.test(plain) && plain.includes('Re-approve my folder notes in DataBrain'), `repair says what only the user can do:\n${plain}`);
      assert(/Still wrong:\n- Check BLOCKED: Local setup audit/.test(plain), `repair reports the audit that cannot pass:\n${plain}`);
      assert.equal(await hash(brain.statePath), stateBytes, 'repair without reapprove does not touch the saved folder record');
      assert.equal(await hash(brain.tsvPath), tsvBytes);
      // a folder that is not in the approved list: refused, nothing read or changed
      const outside = path.join(temp, 'elsewhere'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'x.md'), '# X\noutsidemarker.\n');
      for (const request of [outside, 'elsewhere', 'Documents']) {
        const denied = await server.tool('databrain_repair', { reapprove: request });
        assert(/Re-approval refused/.test(denied) && /Nothing was read or changed/.test(denied), `reapprove for a folder that is not approved is refused:\n${denied}`);
      }
      assert.equal(await hash(brain.statePath), stateBytes, 'a refused re-approval changes nothing');
      assert.equal(await hash(brain.tsvPath), tsvBytes);
      assert.equal((await brain.state()).roots.length, 1, 'no folder was added');
      assert(/changed identity/.test(await server.tool('databrain_search', { query: 'replacedmarker' })), 'still refused');
      // the folder is in the approved list: re-approved
      const approved = await server.tool('databrain_repair', { reapprove: 'notes' });
      assert(/Re-approved/.test(approved), approved);
      assert(/Still wrong: nothing\./.test(approved), approved);
      const found = await server.tool('databrain_search', { query: 'replacedmarker' });
      assert(found.includes('a.md'), `reads work after re-approval:\n${found}`);
      noFail(await server.tool('databrain_verify_install'), 'after re-approval');
      assert.equal(await brain.jobStarts('initial indexing'), startsBefore, 're-approval did not re-index from zero');
    } finally { await server.stop(); }
  }

  // ---------- S6 + S7: two folders, one replaced ----------
  {
    const specs = [['alpha', { 'a1.md': '# A1\nalphamarker one.\n', 'a2.md': '# A2\nsecond alpha note.\n' }], ['bravo', { 'b1.md': '# B1\nbravomarker one.\n', 'b2.md': '# B2\nsecond bravo note.\n' }]];
    const brain = await makeBrain('s6', specs);
    const [alpha, bravo] = brain.roots;
    await replaceFolder(alpha);
    // S6: bravo is revoked in the settings and alpha is replaced. The first call of the session is diagnostics, then repair: neither may throw.
    const server = brain.start([alpha]);
    try {
      await server.ready;
      const diagnostics = await server.tool('databrain_diagnostics');
      assert(diagnostics.startsWith('DataBrain diagnostics.') && /differs from the approved list/.test(diagnostics) && /a different folder now sits at this path/.test(diagnostics), `diagnostics still answers with a revoked root and a replaced folder:\n${diagnostics}`);
      const plain = await server.tool('databrain_repair');
      assert(/Only the user can fix:/.test(plain) && /Re-approve my folder alpha in DataBrain/.test(plain), `repair still answers with a revoked root and a replaced folder:\n${plain}`);
      const refused = await server.tool('databrain_search', { query: 'alphamarker' });
      assert(/changed identity/.test(refused) && refused.includes(REPAIR_LINE), `normal tools are refused:\n${refused}`);
      const approved = await server.tool('databrain_repair', { reapprove: alpha });   // an absolute path works as well as a name
      assert(/Re-approved/.test(approved), approved);
      await until(async () => (await server.tool('databrain_search', { query: 'alphamarker' })).includes('a1.md'), 'alpha readable after re-approval');
    } finally { await server.stop(); }
    // bravo is approved but not in the settings list: reapprove refuses it and changes nothing
    const second = brain.start([alpha, bravo]);
    try {
      await second.ready;
      await until(async () => (await brain.state()).roots.length === 2, 'both folders approved again');
    } finally { await second.stop(); }
    await replaceFolder(bravo);
    const third = brain.start([alpha]);
    try {
      await third.ready;
      const stateBytes = await hash(brain.statePath);
      const denied = await third.tool('databrain_repair', { reapprove: 'bravo' });
      assert(/Re-approval refused/.test(denied) && /not in the folder list of the extension settings/.test(denied), `reapprove refuses a folder the settings no longer list:\n${denied}`);
      assert.equal(await hash(brain.statePath), stateBytes, 'a refused re-approval changes nothing');
    } finally { await third.stop(); }
  }
  {
    const specs = [['alpha', { 'a1.md': '# A1\nalphamarkerseven one.\n', 'a2.md': '# A2\nsecond alpha note.\n' }], ['bravo', { 'b1.md': '# B1\nbravomarkerseven one.\n', 'b2.md': '# B2\nsecond bravo note.\n' }]];
    const brain = await makeBrain('s7', specs);
    const [alpha, bravo] = brain.roots;
    await replaceFolder(alpha);
    // Settings: remove alpha, Save. The replaced folder is dropped without a check, bravo keeps working.
    const removed = brain.start([bravo]);
    try {
      await removed.ready;
      await until(async () => (await removed.tool('databrain_search', { query: 'bravomarkerseven' })).includes('b1.md'), 'bravo readable after alpha was removed in settings');
      await until(async () => (await brain.state()).roots.length === 1, 'alpha dropped from the approved list');
    } finally { await removed.stop(); }
    // Settings: add alpha again, Save. It is a new folder to DataBrain: a fresh identity, indexed again.
    const added = brain.start([alpha, bravo]);
    try {
      await added.ready;
      await until(async () => (await added.tool('databrain_search', { query: 'alphamarkerseven' })).includes('a1.md'), 'alpha readable after it was added again in settings', 180000);
      assert.equal((await brain.state()).roots.length, 2);
    } finally { await added.stop(); }
  }

  console.log('PASS: repair fixes a renumbered disk, a stale lock, a dead job record, an unlabeled row, an empty, missing and unreadable search database and an interrupted stage with no other action; it changes nothing on a healthy brain; diagnostics and repair answer while a folder check would throw; a replaced folder is re-approved only by reapprove for a listed folder; remove-save-add in settings works with two folders.');
} finally {
  for (const kid of kids) kid.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
